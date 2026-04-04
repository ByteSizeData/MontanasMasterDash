#!/usr/bin/env python3
"""
Montana's Master Dash — Luna Blackboard Scraper
Logs into bb.luna.edu, scrapes all courses, assignments, discussions, quizzes with due dates.
Usage: python3 ~/MontanasMasterDash/sync.py --push
"""

import requests, json, os, sys, re, subprocess
from datetime import datetime, timezone
from bs4 import BeautifulSoup
from urllib.parse import urljoin

BB_URL = "https://bb.luna.edu"
USERNAME = "montana.prakotsakon"
PASSWORD = "VintageTricycleTheology0"
TASKS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.json")

# Only include current term tasks (after this date)
TERM_START = datetime(2026, 1, 1)

def log(msg):
    print(f"  → {msg}")

def login(session):
    """Login to standard Blackboard"""
    log("Logging into Luna Blackboard...")

    # Try standard Blackboard login
    login_url = f"{BB_URL}/webapps/login/"
    payload = {
        "user_id": USERNAME,
        "password": PASSWORD,
        "login": "Login",
        "action": "login",
        "new_loc": "",
    }

    resp = session.post(login_url, data=payload, allow_redirects=True)

    # Check if login succeeded by looking for logout link or user menu
    if "logout" in resp.text.lower() or "logoutLink" in resp.text or resp.url != login_url:
        log("Login successful!")
        return True

    # Try alternate login endpoint
    login_url2 = f"{BB_URL}/webapps/bb-auth-provider-spi-bb_bb60/execute/authValidate/loginRedirect"
    resp2 = session.post(login_url2, data=payload, allow_redirects=True)
    if "logout" in resp2.text.lower() or resp2.url != login_url2:
        log("Login successful (alternate)!")
        return True

    log("WARNING: Login may have failed. Continuing to try APIs...")
    return False

def get_courses(session):
    """Get enrolled courses via REST API"""
    log("Fetching courses...")
    courses = []

    # Try REST API first
    try:
        url = f"{BB_URL}/learn/api/v1/users/me/memberships?expand=course&limit=100"
        resp = session.get(url)
        if resp.status_code == 200:
            data = resp.json()
            for item in data.get("results", []):
                course = item.get("course", {})
                cid = course.get("id", "")
                name = course.get("name", "") or course.get("courseId", "")
                course_id_str = course.get("courseId", "")
                if cid:
                    courses.append({"id": cid, "name": name, "courseId": course_id_str})
            if courses:
                log(f"Found {len(courses)} courses via REST API")
                return courses
    except Exception as e:
        log(f"REST API failed: {e}")

    # Try public REST API
    try:
        url = f"{BB_URL}/learn/api/public/v1/users/me/memberships?expand=course&limit=100"
        resp = session.get(url)
        if resp.status_code == 200:
            data = resp.json()
            for item in data.get("results", []):
                course = item.get("course", {})
                cid = course.get("id", "")
                name = course.get("name", "") or course.get("courseId", "")
                course_id_str = course.get("courseId", "")
                if cid:
                    courses.append({"id": cid, "name": name, "courseId": course_id_str})
            if courses:
                log(f"Found {len(courses)} courses via public REST API")
                return courses
    except Exception as e:
        log(f"Public REST API failed: {e}")

    # Fallback: scrape course list page
    try:
        url = f"{BB_URL}/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1"
        resp = session.get(url)
        soup = BeautifulSoup(resp.text, "html.parser")
        for link in soup.find_all("a", href=True):
            href = link["href"]
            if "/webapps/blackboard/execute/launcher" in href and "course_id=" in href:
                match = re.search(r"course_id=(_\d+_\d+)", href)
                if match:
                    cid = match.group(1)
                    name = link.get_text(strip=True)
                    if name and cid not in [c["id"] for c in courses]:
                        courses.append({"id": cid, "name": name, "courseId": ""})
        if courses:
            log(f"Found {len(courses)} courses via HTML scraping")
    except Exception as e:
        log(f"HTML scraping failed: {e}")

    return courses

def get_gradebook_items(session, course_id, course_name):
    """Get assignments from gradebook columns"""
    items = []

    for api_base in ["/learn/api/public/v1", "/learn/api/v1"]:
        try:
            url = f"{BB_URL}{api_base}/courses/{course_id}/gradebook/columns?limit=200"
            resp = session.get(url)
            if resp.status_code != 200:
                continue
            data = resp.json()
            for col in data.get("results", []):
                name = col.get("name", "")
                if not name or name.lower() in ["total", "weighted total", "final grade", "attendance"]:
                    continue
                due = col.get("grading", {}).get("due")
                if not due:
                    due = col.get("dueDate")

                # Skip old items
                if due:
                    try:
                        dt = datetime.fromisoformat(due.replace("Z", "+00:00"))
                        if dt.replace(tzinfo=None) < TERM_START:
                            continue
                    except:
                        pass

                task_type = detect_type(name)
                items.append({
                    "name": name,
                    "course": course_name,
                    "dueDate": format_date(due) if due else "",
                    "type": task_type,
                    "link": f"{BB_URL}/ultra/courses/{course_id}/outline",
                    "hints": get_hints(task_type),
                })
            if items:
                return items
        except Exception as e:
            continue

    return items

def get_content_items(session, course_id, course_name):
    """Get assignments from course contents"""
    items = []

    for api_base in ["/learn/api/public/v1", "/learn/api/v1"]:
        try:
            url = f"{BB_URL}{api_base}/courses/{course_id}/contents?limit=200"
            resp = session.get(url)
            if resp.status_code != 200:
                continue
            data = resp.json()
            for item in data.get("results", []):
                process_content_item(session, api_base, course_id, course_name, item, items)
            if items:
                return items
        except:
            continue

    return items

def process_content_item(session, api_base, course_id, course_name, item, items):
    """Process a content item, recursing into folders"""
    title = item.get("title", "")
    content_type = item.get("contentHandler", {}).get("id", "")
    has_children = item.get("hasChildren", False)

    # Skip non-graded items
    skip_types = ["resource/x-bb-folder", "resource/x-bb-module-page"]

    if has_children and content_type in skip_types:
        # Recurse into folders
        try:
            child_url = f"{BB_URL}{api_base}/courses/{course_id}/contents/{item['id']}/children?limit=200"
            resp = session.get(child_url)
            if resp.status_code == 200:
                for child in resp.json().get("results", []):
                    process_content_item(session, api_base, course_id, course_name, child, items)
        except:
            pass
        return

    # Graded content types
    graded_types = ["resource/x-bb-assignment", "resource/x-bb-asmt-test-link",
                    "resource/x-bb-forumlink", "resource/x-bb-blti-link"]

    if content_type in graded_types or any(kw in title.lower() for kw in ["assignment", "quiz", "test", "exam", "discussion", "homework", "hw", "lab", "project", "midterm", "final"]):
        due = item.get("availability", {}).get("adaptiveRelease", {}).get("end")
        if not due:
            due = item.get("dueDate")

        if due:
            try:
                dt = datetime.fromisoformat(due.replace("Z", "+00:00"))
                if dt.replace(tzinfo=None) < TERM_START:
                    return
            except:
                pass

        task_type = detect_type(title)
        if not any(i["name"] == title and i["course"] == course_name for i in items):
            items.append({
                "name": title,
                "course": course_name,
                "dueDate": format_date(due) if due else "",
                "type": task_type,
                "link": f"{BB_URL}/ultra/courses/{course_id}/outline",
                "hints": get_hints(task_type),
            })

def detect_type(name):
    """Detect task type from name"""
    n = name.lower()
    if any(kw in n for kw in ["discussion", "forum", "db ", "db:", "respond", "reply"]):
        return "discussion"
    if any(kw in n for kw in ["quiz", "test", "exam", "midterm", "final exam"]):
        return "quiz"
    if any(kw in n for kw in ["project", "presentation", "group"]):
        return "project"
    if any(kw in n for kw in ["lab"]):
        return "assignment"
    return "assignment"

def get_hints(task_type):
    """Get navigation hints based on task type"""
    hints = {
        "discussion": "Course → Discussions (left sidebar) → find this discussion thread",
        "quiz": "Course → Course Content → find the quiz, or check Grades for link",
        "assignment": "Course → Assignments (left sidebar) → find this assignment",
        "project": "Course → Assignments or Course Content → find this project",
    }
    return hints.get(task_type, "Course → Course Content → look for this item")

def format_date(date_str):
    """Format ISO date to local datetime-local format"""
    if not date_str:
        return ""
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%dT%H:%M")
    except:
        return date_str

def main():
    push = "--push" in sys.argv

    print("\n🎓 Montana's Master Dash — Luna Blackboard Scraper")
    print("=" * 50)

    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    })

    # Login
    logged_in = login(session)

    # Also try cookie-based auth
    try:
        import browser_cookie3
        log("Also loading Chrome cookies for bb.luna.edu...")
        cj = browser_cookie3.chrome(domain_name=".luna.edu")
        for cookie in cj:
            session.cookies.set(cookie.name, cookie.value, domain=cookie.domain)
        log("Chrome cookies loaded!")
    except Exception as e:
        log(f"browser_cookie3 not available: {e}")

    # Get courses
    courses = get_courses(session)
    if not courses:
        print("\n❌ No courses found. Make sure you're logged into bb.luna.edu in Chrome.")
        print("   Then run: python3 ~/MontanasMasterDash/sync.py --push")
        return

    print(f"\n📚 Found {len(courses)} courses:")
    for c in courses:
        print(f"   • {c['name']}")

    # Scrape each course
    all_tasks = []
    existing = {}
    if os.path.exists(TASKS_FILE):
        try:
            with open(TASKS_FILE) as f:
                for t in json.load(f):
                    existing[t["name"] + "|" + t["course"]] = t
        except:
            pass

    for i, course in enumerate(courses):
        print(f"\n🔍 Scraping {course['name']} ({i+1}/{len(courses)})...")

        # Get from gradebook
        gb_items = get_gradebook_items(session, course["id"], course["name"])
        log(f"Gradebook: {len(gb_items)} items")

        # Get from content
        ct_items = get_content_items(session, course["id"], course["name"])
        log(f"Content: {len(ct_items)} items")

        # Merge (avoid duplicates)
        seen = set()
        for item in gb_items + ct_items:
            key = item["name"] + "|" + item["course"]
            if key not in seen:
                seen.add(key)
                # Preserve existing data
                if key in existing:
                    item["id"] = existing[key].get("id", "")
                    item["completed"] = existing[key].get("completed", False)
                    item["notes"] = existing[key].get("notes", "")
                    item["createdAt"] = existing[key].get("createdAt", "")

                if not item.get("id"):
                    item["id"] = f"luna_{hash(key) & 0xFFFFFFFF}"
                if not item.get("completed"):
                    item["completed"] = False
                if not item.get("notes"):
                    item["notes"] = ""
                if not item.get("createdAt"):
                    item["createdAt"] = datetime.now().isoformat()

                all_tasks.append(item)

    # Sort by due date
    all_tasks.sort(key=lambda t: t.get("dueDate") or "9999")

    # Save
    with open(TASKS_FILE, "w") as f:
        json.dump(all_tasks, f, indent=2)

    print(f"\n✅ Saved {len(all_tasks)} tasks to tasks.json")

    # Push to GitHub
    if push:
        print("\n📤 Pushing to GitHub...")
        os.chdir(os.path.dirname(os.path.abspath(__file__)))
        subprocess.run(["git", "add", "-A"], check=True)
        subprocess.run(["git", "commit", "-m", f"Sync {len(all_tasks)} tasks from Luna Blackboard"], check=True)
        subprocess.run(["git", "push", "origin", "main"], check=True)
        print("✅ Pushed! Refresh dashboard to see updates.")

    print("\n🎉 Done!")

if __name__ == "__main__":
    main()
