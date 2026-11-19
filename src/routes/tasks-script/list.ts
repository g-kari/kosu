/**
 * Task list loading and rendering for the /app/tasks inline script.
 *
 * One section of the former inline TASKS_SCRIPT (split for
 * maintainability, KAZAMI-345). The sections are concatenated
 * in order by ./index.ts and the result is byte-identical to
 * the original single script, so page behaviour is unchanged.
 * The first line follows the opening backtick directly so the
 * concatenation keeps exactly the original bytes.
 */
export const TASKS_SCRIPT_LIST = `async function loadTasks() {
  const params = new URLSearchParams();
  const q = $("fQ").value.trim();
  if (q) params.set("q", q);
  const st = checkedValues("fStatuses");
  if (st.length && st.length < statusDefs.length) params.set("status", st.join(","));
  const pr = checkedValues("fPriorities");
  if (pr.length && pr.length < priorityDefs.length) params.set("priority", pr.join(","));
  if ($("fAssignee").value) params.set("assignee_account_id", $("fAssignee").value);
  if ($("fLabel").value) params.set("label_id", $("fLabel").value);
  if ($("fDueFrom").value) params.set("due_from", $("fDueFrom").value);
  if ($("fDueTo").value) params.set("due_to", $("fDueTo").value);
  if ($("fArchived").checked) params.set("include_archived", "1");
  const data = await ui.api(ui.projectPath() + "/tasks?" + params.toString());
  taskCache = data.tasks;
  renderList();
}
function orderedTasks() {
  const byId = new Map(taskCache.map((t) => [t.id, t]));
  const children = new Map();
  const roots = [];
  for (const t of taskCache) {
    if (t.parent_task_id && byId.has(t.parent_task_id)) {
      const arr = children.get(t.parent_task_id) || [];
      arr.push(t);
      children.set(t.parent_task_id, arr);
    } else roots.push(t);
  }
  const out = [];
  const walk = (t, depth) => {
    out.push({ task: t, depth });
    for (const ch of children.get(t.id) || []) walk(ch, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}
function renderList() {
  const tbody = $("taskRows");
  tbody.innerHTML = "";
  const today = ui.todayStr();
  const items = orderedTasks();
  if (items.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "muted";
    if (taskCache.length === 0) {
      td.textContent = "タスクがまだありません。";
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "最初のタスクを作成";
      b.onclick = () => { $("createForm").scrollIntoView({ behavior: "smooth", block: "start" }); $("cTitle").focus(); };
      td.appendChild(document.createTextNode(" "));
      td.appendChild(b);
    } else {
      td.textContent = "条件に合うタスクがありません。";
    }
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const item of items) {
    const t = item.task;
    const tr = document.createElement("tr");
    tr.className = "clickable";
    if (t.id === selectedId) tr.style.background = "#eef1f8";
    tr.onclick = () => selectTask(t.id);
    tr.tabIndex = 0;
    tr.onkeydown = (ev) => {
      if (ev.target === tr && (ev.key === "Enter" || ev.key === " ")) {
        ev.preventDefault();
        selectTask(t.id);
      }
    };
    const td1 = document.createElement("td");
    td1.textContent = (item.depth ? "　".repeat(item.depth) + "↳ " : "") + t.title;
    if (t.archived_at) td1.className = "muted";
    const td2 = document.createElement("td");
    const sel = document.createElement("select");
    ui.fillSelect(sel, statusDefs, (d) => d.slug, (d) => d.name);
    sel.value = t.status;
    sel.onclick = (ev) => ev.stopPropagation();
    sel.onchange = async (ev) => {
      ev.stopPropagation();
      try {
        const r = await ui.api(ui.projectPath() + "/tasks/" + t.id, ui.jsonOpts("PATCH", { status: sel.value }));
        Object.assign(t, r.task);
        if (selectedId === t.id) fillDetail(r.task);
      } catch (e) { $("msg").textContent = e.message; sel.value = t.status; }
    };
    td2.appendChild(sel);
    const td3 = document.createElement("td");
    td3.textContent = defName(priorityDefs, t.priority);
    const td4 = document.createElement("td");
    td4.textContent = ui.memberName(t.assignee_account_id);
    const td5 = document.createElement("td");
    td5.textContent = t.due_date || "";
    if (t.due_date && t.status !== "done") td5.className = t.due_date < today ? "due-over" : (t.due_date <= ui.addDays(today, 3) ? "due-soon" : "");
    const td6 = document.createElement("td");
    td6.id = "labels-" + t.id;
    tr.append(td1, td2, td3, td4, td5, td6);
    tbody.appendChild(tr);
  }
  $("taskCount").textContent = taskCache.length + " 件";
  // Label chips load lazily per visible task.
  for (const t of taskCache) {
    ui.api(ui.projectPath() + "/tasks/" + t.id + "/labels").then((d) => {
      const cell = document.getElementById("labels-" + t.id);
      if (!cell) return;
      for (const l of d.labels) {
        const s = document.createElement("span");
        s.className = "tag";
        if (l.color) s.style.borderLeftColor = l.color;
        s.textContent = l.name;
        cell.appendChild(s);
      }
    }).catch(() => {});
  }
}
`;
