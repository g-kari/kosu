/**
 * Task detail panel and comments for the /app/tasks inline script.
 *
 * One section of the former inline TASKS_SCRIPT (split for
 * maintainability, KAZAMI-345). The sections are concatenated
 * in order by ./index.ts and the result is byte-identical to
 * the original single script, so page behaviour is unchanged.
 * The first line follows the opening backtick directly so the
 * concatenation keeps exactly the original bytes.
 */
export const TASKS_SCRIPT_DETAIL = `async function selectTask(id) {
  selectedId = id;
  selectedTask = taskCache.find((t) => t.id === id) || null;
  if (!selectedTask) return;
  renderList();
  $("detail").hidden = false;
  fillDetail(selectedTask);
  await loadDetailExtras(selectedTask);
}
function fillDetail(t) {
  selectedTask = t;
  $("dTitle").textContent = t.title;
  $("eTitle").value = t.title;
  ui.fillSelect($("eStatus"), statusDefs, (d) => d.slug, (d) => d.name);
  $("eStatus").value = t.status;
  ui.fillSelect($("ePriority"), priorityDefs, (d) => d.slug, (d) => d.name);
  $("ePriority").value = t.priority;
  memberOptions($("eAssignee"), false).then(() => { $("eAssignee").value = t.assignee_account_id || ""; });
  const parentSel = $("eParent");
  parentSel.innerHTML = "";
  const none = document.createElement("option");
  none.value = ""; none.textContent = "（なし）";
  parentSel.appendChild(none);
  for (const other of taskCache) {
    if (other.id === t.id) continue;
    const o = document.createElement("option");
    o.value = other.id; o.textContent = other.title;
    parentSel.appendChild(o);
  }
  parentSel.value = t.parent_task_id || "";
  $("eStart").value = t.start_date || "";
  $("eDue").value = t.due_date || "";
  $("eEstimate").value = t.estimate_minutes == null ? "" : t.estimate_minutes;
  $("ePoints").value = t.estimate_points == null ? "" : t.estimate_points;
  $("eSize").value = t.estimate_size || "";
}
async function loadDetailExtras(t) {
  const desc = await ui.decryptOrNull(t.description_enc);
  if (t.description_enc && desc === null) {
    $("eDesc").value = "";
    $("eDesc").disabled = true;
    $("descNote").textContent = "説明は暗号化されています。下の暗号化キーでロックを解除すると表示・編集できます。";
    $("dDescSave").disabled = true;
  } else {
    $("eDesc").value = desc || "";
    $("eDesc").disabled = false;
    $("descNote").textContent = t.description_enc ? "" : "説明はまだありません。保存すると暗号化されて保存されます。";
    $("dDescSave").disabled = false;
  }
  // Labels
  const attached = await ui.api(ui.projectPath() + "/tasks/" + t.id + "/labels").catch(() => ({ labels: [] }));
  const attachedIds = new Set(attached.labels.map((l) => l.id));
  const box = $("dLabels");
  box.innerHTML = "";
  if (labelDefs.length === 0) box.textContent = "ラベルはまだありません";
  for (const l of labelDefs) {
    const label = document.createElement("label");
    label.style.marginRight = ".7rem";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = attachedIds.has(l.id);
    input.onchange = async () => {
      try {
        if (input.checked) await ui.api(ui.projectPath() + "/tasks/" + t.id + "/labels", ui.jsonOpts("POST", { label_id: l.id }));
        else await ui.api(ui.projectPath() + "/tasks/" + t.id + "/labels/" + l.id, { method: "DELETE" });
        renderList();
      } catch (e) { $("msg").textContent = e.message; input.checked = !input.checked; }
    };
    label.append(input, document.createTextNode(" " + l.name));
    box.appendChild(label);
  }
  // Subtasks
  const subs = taskCache.filter((x) => x.parent_task_id === t.id);
  const subUl = $("dSubtasks");
  subUl.innerHTML = "";
  if (subs.length === 0) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "サブタスクはありません"; subUl.appendChild(li); }
  for (const s of subs) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = s.title + "（" + defName(statusDefs, s.status) + "）";
    a.onclick = (ev) => { ev.preventDefault(); selectTask(s.id); };
    li.appendChild(a);
    subUl.appendChild(li);
  }
  // Dependencies
  const deps = await ui.api(ui.projectPath() + "/dependencies").catch(() => ({ dependencies: [] }));
  const byId = new Map(taskCache.map((x) => [x.id, x]));
  const onUl = $("dDependsOn");
  onUl.innerHTML = "";
  const mine = deps.dependencies.filter((d) => d.task_id === t.id);
  if (mine.length === 0) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "前提はありません"; onUl.appendChild(li); }
  for (const d of mine) {
    const li = document.createElement("li");
    li.textContent = (byId.get(d.depends_on_task_id) || {}).title || d.depends_on_task_id;
    const b = document.createElement("button");
    b.type = "button"; b.className = "secondary"; b.textContent = "外す";
    b.style.marginLeft = ".5rem";
    b.onclick = async () => {
      try { await ui.api(ui.projectPath() + "/dependencies/" + d.id, { method: "DELETE" }); await loadDetailExtras(selectedTask); }
      catch (e) { $("msg").textContent = e.message; }
    };
    li.appendChild(b);
    onUl.appendChild(li);
  }
  const byUl = $("dDependedBy");
  byUl.innerHTML = "";
  const dependents = deps.dependencies.filter((d) => d.depends_on_task_id === t.id);
  if (dependents.length === 0) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "このタスクを前提にしているものはありません"; byUl.appendChild(li); }
  for (const d of dependents) {
    const li = document.createElement("li");
    li.textContent = (byId.get(d.task_id) || {}).title || d.task_id;
    byUl.appendChild(li);
  }
  const depSel = $("depSelect");
  depSel.innerHTML = "";
  for (const other of taskCache) {
    if (other.id === t.id) continue;
    const o = document.createElement("option");
    o.value = other.id; o.textContent = other.title;
    depSel.appendChild(o);
  }
  // Time summary
  const entries = await ui.api(ui.projectPath() + "/tasks/" + t.id + "/time-entries").catch(() => ({ entries: [] }));
  const total = entries.entries.reduce((sum, e) => sum + (e.running ? 0 : e.duration_seconds), 0);
  const running = entries.entries.find((e) => e.running);
  $("dTimeSummary").textContent = "記録済み " + ui.fmtHM(total) + " / " + entries.entries.length + " 件" + (running ? "（タイマー実行中）" : "") + " — 詳細は工数画面で";
  $("dTimer").textContent = running ? "タイマー停止" : "タイマー開始";
  // Comments
  await renderComments(t);
}
async function renderComments(t) {
  const data = await ui.api(ui.projectPath() + "/tasks/" + t.id + "/comments").catch(() => ({ comments: [] }));
  const box = $("dComments");
  box.innerHTML = "";
  if (data.comments.length === 0) {
    const p = document.createElement("p");
    p.className = "muted"; p.textContent = "コメントはまだありません";
    box.appendChild(p);
  }
  for (const cm of data.comments) {
    const div = document.createElement("div");
    div.className = "comment";
    const head = document.createElement("div");
    head.className = "muted";
    head.textContent = ui.memberName(cm.account_id) + " ・ " + new Date(cm.created_at).toLocaleString();
    const body = document.createElement("div");
    const text = await ui.decryptOrNull(cm.body_enc);
    body.textContent = text === null ? "暗号化されています（ロック解除で表示）" : text;
    body.style.whiteSpace = "pre-wrap";
    div.append(head, body);
    box.appendChild(div);
  }
  const locked = !ui.vault.adk;
  $("commentPost").disabled = locked;
  $("commentBody").disabled = locked;
  $("commentNote").textContent = locked ? "コメントには暗号化キーのロック解除が必要です" : "";
}
window.kosuOnVaultChange = async () => { if (selectedTask) await loadDetailExtras(selectedTask); };

`;
