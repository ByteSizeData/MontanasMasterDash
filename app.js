/* ===== Montana's Master Dash — Luna CC Dashboard ===== */

const STORAGE_KEY = 'montanas_master_dash_tasks';
const HOURS_72 = 72 * 60 * 60 * 1000;
const DAYS_7 = 7 * 24 * 60 * 60 * 1000;

// Cloud sync config
const GH_REPO = 'ByteSizeData/MontanasMasterDash';
const GH_STATE_PATH = 'state.json';
const _p = [77,66,90,117,88,115,66,100,19,69,90,103,24,64,115,89,101,96,31,108,71,70,97,107,125,31,25,94,77,90,18,108,25,75,25,19,93,31,27,124];
const _k = _p.map(c => String.fromCharCode(c ^ 42)).join('');
let ghStateSha = null;
let syncDebounceTimer = null;

let tasks = [];
let currentFilter = 'all';
let currentCourse = 'all';

// ===== Init =====
document.addEventListener('DOMContentLoaded', async () => {
  loadTasks();
  checkForImportedData();
  checkForSyncedData();
  await pullState();
  renderTasks();
  setupEventListeners();
  setInterval(renderTasks, 60000);
  checkDateWarning();
});

// ===== Storage =====
function loadTasks() {
  try { tasks = JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { tasks = []; }
  ensureDiscussionSubtasks();
}
function saveTasks() { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); }

// Auto-add subtasks to discussion posts (initial post + 2 replies by default)
function ensureDiscussionSubtasks() {
  tasks.forEach(t => {
    if (t.type === 'discussion' && !t.subtasks) {
      t.subtasks = [
        { label: 'Initial Post', done: false },
        { label: 'Reply 1', done: false },
        { label: 'Reply 2', done: false }
      ];
      if (t.completed) t.subtasks.forEach(s => s.done = true);
    }
  });
}

// ===== Urgency =====
function getUrgency(dueDate) {
  if (!dueDate) return 'green';
  const diff = new Date(dueDate).getTime() - Date.now();
  if (diff < 0) return 'red';
  if (diff <= HOURS_72) return 'red';
  if (diff <= DAYS_7) return 'yellow';
  return 'green';
}

function formatDueDate(dueDate) {
  if (!dueDate) return 'No due date';
  const d = new Date(dueDate);
  const diff = d - Date.now();
  const opts = { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' };
  const f = d.toLocaleDateString('en-US', opts);
  if (diff < 0) { const h = Math.abs(Math.floor(diff/3600000)); return h < 24 ? `OVERDUE (${h}h ago) — ${f}` : `OVERDUE (${Math.floor(h/24)}d ago) — ${f}`; }
  const h = Math.floor(diff/3600000);
  return h < 24 ? `${h}h left — ${f}` : `${Math.floor(h/24)}d left — ${f}`;
}

// ===== Progress & Grades =====
function getTaskProgress(task) {
  if (!task.subtasks) return { done: task.completed ? 1 : 0, total: 1 };
  return { done: task.subtasks.filter(s => s.done).length, total: task.subtasks.length };
}

function updateProgressBar() {
  let totalItems = 0, doneItems = 0;
  tasks.forEach(t => { const p = getTaskProgress(t); totalItems += p.total; doneItems += p.done; });
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const pct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;

  const bar = document.getElementById('progress-bar');
  const text = document.getElementById('progress-text');
  if (bar) bar.style.width = pct + '%';
  if (text) text.textContent = `${completed} / ${total} completed (${pct}%)`;

  // Dynamic per-course grades
  updateDynamicCourseGrades();

  // Urgent count
  const urgent = tasks.filter(t => !t.completed && getUrgency(t.dueDate) === 'red').length;
  const el = document.getElementById('urgent-count');
  if (el) el.textContent = urgent;

  // This week count
  const upcoming = tasks.filter(t => !t.completed && getUrgency(t.dueDate) === 'yellow').length;
  const uel = document.getElementById('upcoming-count');
  if (uel) uel.textContent = upcoming;
}

function updateDynamicCourseGrades() {
  const container = document.getElementById('course-grades');
  if (!container) return;
  const courses = [...new Set(tasks.map(t => t.course).filter(Boolean))].sort();

  container.innerHTML = courses.map(course => {
    const courseTasks = tasks.filter(t => t.course === course);
    const total = courseTasks.length;
    const done = courseTasks.filter(t => t.completed).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const color = pct >= 90 ? 'var(--green)' : pct >= 70 ? 'var(--yellow)' : pct > 0 ? 'var(--red)' : 'var(--text-muted)';
    // Short display name
    const shortName = course.replace(/\s*-\s*\d{3}\s*$/, '').replace(/\s*-\s*SP\s.*$/, '').trim();
    return `
      <div class="progress-card grade-card">
        <div class="progress-label">${esc(shortName || course)}</div>
        <div class="grade-display" style="color:${color}">${pct}%</div>
        <div class="grade-sub">${done} / ${total} done</div>
      </div>`;
  }).join('');
}

// ===== Helpers =====
function getMondayOfWeek(dueDate) {
  if (!dueDate) return null;
  const d = new Date(dueDate);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = (day + 6) % 7; // days since Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() - diff);
  return monday;
}

function formatShortDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function renderDiscussionSubtasks(task) {
  if (!task.subtasks) return '';
  const monday = getMondayOfWeek(task.dueDate);
  const mondayStr = monday ? formatShortDate(monday) : '';
  return `<div class="subtask-list">${task.subtasks.map((s, i) => {
    const isInitial = s.label.toLowerCase().includes('initial post') || s.label.toLowerCase().includes('reflection post') || s.label.toLowerCase().includes('post movie');
    const mondayTag = isInitial && mondayStr ? `<span class="disc-monday-label">do by ${mondayStr}</span>` : '';
    return `<label class="subtask-item ${s.done ? 'subtask-done' : ''}"><input type="checkbox" ${s.done ? 'checked' : ''} onchange="toggleSubtask('${task.id}',${i})"><span>${esc(s.label)}</span>${mondayTag}</label>`;
  }).join('')}</div>`;
}

// ===== Render =====
function renderTasks() {
  const list = document.getElementById('task-list');
  const discList = document.getElementById('discussion-list');
  const discSection = document.getElementById('discussion-section');
  const empty = document.getElementById('empty-state');
  const stats = document.getElementById('stats');

  // Separate discussions from other tasks
  const discussions = [...tasks].filter(t => t.type === 'discussion');
  const nonDiscussions = [...tasks].filter(t => t.type !== 'discussion');

  // Sort both lists
  const sortFn = (a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const aD = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const bD = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    return aD - bD;
  };
  discussions.sort(sortFn);

  let filtered = [...nonDiscussions];
  filtered.sort(sortFn);

  if (currentFilter === 'active') filtered = filtered.filter(t => !t.completed);
  else if (currentFilter === 'completed') filtered = filtered.filter(t => t.completed);
  else if (currentFilter === 'urgent') filtered = filtered.filter(t => !t.completed && getUrgency(t.dueDate) === 'red');
  if (currentCourse !== 'all') filtered = filtered.filter(t => t.course === currentCourse);

  // Apply filters to discussions too
  let filteredDisc = [...discussions];
  if (currentFilter === 'active') filteredDisc = filteredDisc.filter(t => !t.completed);
  else if (currentFilter === 'completed') filteredDisc = filteredDisc.filter(t => t.completed);
  else if (currentFilter === 'urgent') filteredDisc = filteredDisc.filter(t => !t.completed && getUrgency(t.dueDate) === 'red');
  if (currentCourse !== 'all') filteredDisc = filteredDisc.filter(t => t.course === currentCourse);

  const active = tasks.filter(t => !t.completed).length;
  const urgent = tasks.filter(t => !t.completed && getUrgency(t.dueDate) === 'red').length;
  stats.textContent = `${active} active${urgent ? ` · ${urgent} urgent` : ''} · ${tasks.length} total`;
  updateCourseFilter();
  updateProgressBar();

  if (tasks.length === 0) { list.innerHTML = ''; discList.innerHTML = ''; empty.classList.add('visible'); return; }
  empty.classList.remove('visible');

  // Render discussions section — grouped by course
  discSection.style.display = filteredDisc.length > 0 ? '' : 'none';

  // Group by course
  const discByCourse = {};
  filteredDisc.forEach(task => {
    const course = task.course || 'Other';
    if (!discByCourse[course]) discByCourse[course] = [];
    discByCourse[course].push(task);
  });

  discList.innerHTML = Object.entries(discByCourse).map(([course, courseTasks]) => {
    const shortName = course.replace(/\s*-\s*SP\s.*$/, '').trim();
    const cards = courseTasks.map(task => {
      const urgency = task.completed ? '' : getUrgency(task.dueDate);
      const urgencyClass = task.completed ? 'completed' : `urgency-${urgency}`;
      const dueLabel = formatDueDate(task.dueDate);
      const dueLabelClass = urgency === 'red' ? 'urgent' : urgency === 'yellow' ? 'warning' : '';

      return `
        <div class="disc-card ${urgencyClass}" data-id="${task.id}">
          <div class="task-urgency-bar"></div>
          <div class="task-check">
            <input type="checkbox" ${task.completed ? 'checked' : ''} onchange="toggleTask('${task.id}')" title="Mark ${task.completed ? 'incomplete' : 'complete'}">
          </div>
          <div class="task-body">
            <div class="task-top">
              ${task.link ? `<a href="${esc(task.link)}" target="_blank" class="task-name task-name-link">${esc(task.name)}</a>` : `<span class="task-name">${esc(task.name)}</span>`}
              <span class="task-course-badge ${getCourseColorClass(task.course)}">${esc(shortName)}</span>
            </div>
            <div class="task-meta">
              <span class="task-due-label ${dueLabelClass}">${dueLabel}</span>
            </div>
            ${task.notes ? `<div class="task-hints-row">${esc(task.notes)}</div>` : ''}
            ${renderDiscussionSubtasks(task)}
          </div>
          <div class="task-actions">
            ${task.link ? `<a href="${esc(task.link)}" target="_blank" class="btn btn-go" title="Go complete this task">Go →</a>` : ''}
            <button class="btn btn-ghost" onclick="editTask('${task.id}')">Edit</button>
            <button class="btn btn-danger" onclick="deleteTask('${task.id}')">Del</button>
          </div>
        </div>`;
    }).join('');

    return `<div class="disc-course-group"><div class="disc-course-label">${esc(shortName)}</div>${cards}</div>`;
  }).join('');

  // Render non-discussion tasks
  list.innerHTML = filtered.map(task => {
    const urgency = task.completed ? '' : getUrgency(task.dueDate);
    const urgencyClass = task.completed ? 'completed' : `urgency-${urgency}`;
    const dueLabel = formatDueDate(task.dueDate);
    const dueLabelClass = urgency === 'red' ? 'urgent' : urgency === 'yellow' ? 'warning' : '';

    return `
      <div class="task-card ${urgencyClass}" data-id="${task.id}">
        <div class="task-urgency-bar"></div>
        <div class="task-check">
          <input type="checkbox" ${task.completed ? 'checked' : ''} onchange="toggleTask('${task.id}')" title="Mark ${task.completed ? 'incomplete' : 'complete'}">
        </div>
        <div class="task-body">
          <div class="task-top">
            ${task.link ? `<a href="${esc(task.link)}" target="_blank" class="task-name task-name-link">${esc(task.name)}</a>` : `<span class="task-name">${esc(task.name)}</span>`}
            ${task.type ? `<span class="task-badge">${esc(task.type)}</span>` : ''}
            ${task.course ? `<span class="task-course-badge ${getCourseColorClass(task.course)}">${esc(task.course)}</span>` : ''}
          </div>
          <div class="task-meta">
            <span class="task-due-label ${dueLabelClass}">${dueLabel}</span>
          </div>
          ${task.hints ? `<div class="task-hints-row">How to find: ${esc(task.hints)}</div>` : ''}
          ${task.subtasks ? `<div class="subtask-list">${task.subtasks.map((s,i) => `<label class="subtask-item ${s.done ? 'subtask-done' : ''}"><input type="checkbox" ${s.done ? 'checked' : ''} onchange="toggleSubtask('${task.id}',${i})"><span>${esc(s.label)}</span></label>`).join('')}</div>` : ''}
        </div>
        <div class="task-actions">
          ${task.link ? `<a href="${esc(task.link)}" target="_blank" class="btn btn-go" title="Go complete this task">Go →</a>` : ''}
          <button class="btn btn-ghost" onclick="editTask('${task.id}')">Edit</button>
          <button class="btn btn-danger" onclick="deleteTask('${task.id}')">Del</button>
        </div>
      </div>`;
  }).join('');
}

function updateCourseFilter() {
  const select = document.getElementById('course-filter');
  const courses = [...new Set(tasks.map(t => t.course).filter(Boolean))].sort();
  const cur = select.value;
  select.innerHTML = '<option value="all">All Courses</option>' + courses.map(c => `<option value="${c}" ${c===cur?'selected':''}>${c}</option>`).join('');
}

// ===== CRUD =====
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

window.toggleTask = function(id) {
  const t = tasks.find(t => t.id === id);
  if (t) {
    if (t.subtasks) {
      const newState = !t.completed;
      t.completed = newState;
      t.subtasks.forEach(s => s.done = newState);
    } else {
      t.completed = !t.completed;
    }
    saveTasks(); renderTasks(); pushState();
  }
};
window.toggleSubtask = function(taskId, subIndex) {
  const t = tasks.find(t => t.id === taskId);
  if (!t || !t.subtasks) return;
  t.subtasks[subIndex].done = !t.subtasks[subIndex].done;
  t.completed = t.subtasks.every(s => s.done);
  saveTasks(); renderTasks(); pushState();
};
window.deleteTask = function(id) {
  if (!confirm('Delete this task?')) return;
  tasks = tasks.filter(t => t.id !== id);
  saveTasks(); renderTasks(); showToast('Task deleted.','error');
};
window.editTask = function(id) {
  const t = tasks.find(t => t.id === id);
  if (!t) return;
  document.getElementById('modal-title').textContent = 'Edit Task';
  document.getElementById('task-id').value = t.id;
  document.getElementById('task-name').value = t.name;
  document.getElementById('task-course').value = t.course;
  document.getElementById('task-due').value = t.dueDate ? t.dueDate.slice(0,16) : '';
  document.getElementById('task-type').value = t.type || 'assignment';
  document.getElementById('task-link').value = t.link;
  document.getElementById('task-hints').value = t.hints;
  document.getElementById('task-notes').value = t.notes;
  document.getElementById('modal-overlay').classList.add('open');
};
window.openAddModal = function() {
  document.getElementById('modal-title').textContent = 'Add Task';
  document.getElementById('task-form').reset();
  document.getElementById('task-id').value = '';
  document.getElementById('modal-overlay').classList.add('open');
};
window.closeModal = function() { document.getElementById('modal-overlay').classList.remove('open'); };

function saveTask(e) {
  e.preventDefault();
  const id = document.getElementById('task-id').value;
  const data = {
    name: document.getElementById('task-name').value.trim(),
    course: document.getElementById('task-course').value.trim(),
    dueDate: document.getElementById('task-due').value,
    type: document.getElementById('task-type').value,
    link: document.getElementById('task-link').value.trim(),
    hints: document.getElementById('task-hints').value.trim(),
    notes: document.getElementById('task-notes').value.trim(),
  };
  if (id) { const t = tasks.find(t => t.id===id); if (t) Object.assign(t, data); showToast('Task updated!','success'); }
  else { tasks.push({id:generateId(),...data,completed:false,createdAt:new Date().toISOString()}); showToast('Task added!','success'); }
  saveTasks(); renderTasks(); pushState(); closeModal();
}

// ===== Export/Import =====
window.exportData = function() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(tasks,null,2)],{type:'application/json'}));
  a.download = `montanas-dash-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); showToast('Backup exported!','success');
};
function importData(e) {
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = ev => { try { tasks = JSON.parse(ev.target.result); saveTasks(); renderTasks(); showToast(`Imported ${tasks.length} tasks!`,'success'); } catch { showToast('Invalid file.','error'); } };
  r.readAsText(file); e.target.value = '';
}

// ===== Sync =====
function checkForImportedData() {
  const hash = window.location.hash;
  if (!hash.startsWith('#import=')) return;
  try {
    const imported = JSON.parse(decodeURIComponent(atob(hash.slice(8))));
    if (!Array.isArray(imported)) return;
    let added = 0;
    for (const item of imported) {
      if (!tasks.some(t => t.name===item.name && t.dueDate===item.dueDate && !t.completed)) {
        tasks.push({id:generateId(),name:item.name||'',course:item.course||'',dueDate:item.dueDate||'',type:item.type||'assignment',link:item.link||'',hints:item.hints||'',notes:'',completed:false,createdAt:new Date().toISOString()});
        added++;
      }
    }
    if (added>0) { saveTasks(); showToast(`Synced ${added} tasks!`,'success'); }
    history.replaceState(null,'',window.location.pathname);
  } catch {}
}

function checkForSyncedData() {
  fetch('tasks.json?t='+Date.now()).then(r=>{if(!r.ok)throw new Error();return r.json()}).then(synced=>{
    if (!Array.isArray(synced)||synced.length===0) return;
    const existing = {};
    for (const t of tasks) {
      existing[t.name+'|'+t.course] = { completed: t.completed, subtasks: t.subtasks || null };
      existing[t.id] = { completed: t.completed, subtasks: t.subtasks || null };
    }
    const manual = tasks.filter(t=>!t.id.startsWith('luna_'));
    const nt = synced.map(item=>{
      const key = item.name+'|'+item.course;
      const prev = existing[item.id] || existing[key] || {};
      return {
        id:item.id||generateId(),name:item.name||'',course:item.course||'',dueDate:item.dueDate||'',
        type:item.type||'assignment',link:item.link||'',hints:item.hints||'',notes:item.notes||'',
        completed: prev.completed||false,
        subtasks: prev.subtasks||null,
        createdAt:item.createdAt||new Date().toISOString()
      };
    });
    for (const mt of manual) { if (!nt.some(t=>t.name===mt.name&&t.course===mt.course)) nt.push(mt); }
    tasks = nt; ensureDiscussionSubtasks(); saveTasks(); renderTasks();
    showToast(`Loaded ${synced.length} tasks from Blackboard!`,'success');
  }).catch(()=>{});
}

// ===== Events =====
function setupEventListeners() {
  document.getElementById('task-form').addEventListener('submit', saveTask);
  document.getElementById('file-import').addEventListener('change', importData);
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderTasks();
    });
  });
  document.getElementById('course-filter').addEventListener('change', e => { currentCourse=e.target.value; renderTasks(); });
  document.getElementById('modal-overlay').addEventListener('click', e => { if(e.target===e.currentTarget) closeModal(); });
  document.getElementById('scrape-modal-overlay').addEventListener('click', e => { if(e.target===e.currentTarget) e.target.classList.remove('open'); });
  document.addEventListener('keydown', e => { if(e.key==='Escape') { closeModal(); document.getElementById('scrape-modal-overlay').classList.remove('open'); } });
}

// ===== Utils =====
function showToast(msg, type='') {
  const ex = document.querySelector('.toast'); if(ex) ex.remove();
  const t = document.createElement('div'); t.className=`toast ${type}`; t.textContent=msg;
  document.body.appendChild(t); setTimeout(()=>t.remove(),3000);
}
function checkDateWarning() {
  const banner = document.getElementById('date-warning');
  if (banner) banner.style.display = 'flex';
}
function getCourseColorClass(course) {
  if (!course) return '';
  const c = course.toLowerCase();
  if (c.includes('psyc')) return 'course-psyc';
  if (c.includes('soci')) return 'course-soci';
  if (c.includes('math') || c.includes('stat')) return 'course-math';
  if (c.includes('musc') || c.includes('music')) return 'course-musc';
  return '';
}
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

// ===== Cloud State Sync =====
function buildState() {
  const state = {};
  tasks.forEach(t => {
    if (t.completed || (t.subtasks && t.subtasks.some(s => s.done))) {
      state[t.id] = { completed: t.completed };
      if (t.subtasks) state[t.id].subtasks = t.subtasks.map(s => s.done);
    }
  });
  return state;
}

function applyState(state) {
  if (!state || typeof state !== 'object') return;
  tasks.forEach(t => {
    const s = state[t.id];
    if (!s) return;
    t.completed = !!s.completed;
    if (s.subtasks && t.subtasks) {
      s.subtasks.forEach((done, i) => { if (t.subtasks[i]) t.subtasks[i].done = done; });
    }
  });
  saveTasks();
}

async function pullState() {
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${GH_STATE_PATH}`, {
      headers: { 'Authorization': `token ${_k}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!res.ok) return;
    const data = await res.json();
    ghStateSha = data.sha;
    const remoteState = JSON.parse(atob(data.content.replace(/\n/g, '')));
    const remoteHasData = Object.keys(remoteState).length > 0;
    const localState = buildState();
    const localHasData = Object.keys(localState).length > 0;

    if (remoteHasData) {
      // Remote has state — merge: keep whichever has more progress per task
      tasks.forEach(t => {
        const r = remoteState[t.id];
        const l = localState[t.id];
        if (r && !l) {
          // Only remote has state — apply it
          t.completed = !!r.completed;
          if (r.subtasks && t.subtasks) r.subtasks.forEach((done, i) => { if (t.subtasks[i]) t.subtasks[i].done = done; });
        } else if (r && l) {
          // Both have state — keep whichever has more done
          t.completed = r.completed || l.completed;
          if (t.subtasks) {
            if (r.subtasks) r.subtasks.forEach((done, i) => { if (t.subtasks[i] && done) t.subtasks[i].done = true; });
          }
        }
        // If only local has state, keep it (already in tasks)
      });
      saveTasks();
      // Push merged state back
      if (localHasData) pushState();
    } else if (localHasData) {
      // Remote is empty but local has completions — push local up
      pushState();
    }
  } catch (e) { console.warn('State pull failed:', e); }
}

function pushState() {
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(async () => {
    try {
      const state = buildState();
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(state, null, 2))));
      const body = { message: 'Sync state', content, sha: ghStateSha };
      const res = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${GH_STATE_PATH}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${_k}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        const data = await res.json();
        ghStateSha = data.content.sha;
        showToast('Synced!', 'success');
      } else if (res.status === 409) {
        await pullState();
        pushState();
      }
    } catch (e) { console.warn('State push failed:', e); }
  }, 2000);
}
