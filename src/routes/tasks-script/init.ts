/**
 * Event wiring (ui.onReady) for the /app/tasks inline script.
 *
 * One section of the former inline TASKS_SCRIPT (split for
 * maintainability, KAZAMI-345). The sections are concatenated
 * in order by ./index.ts and the result is byte-identical to
 * the original single script, so page behaviour is unchanged.
 * The first line follows the opening backtick directly so the
 * concatenation keeps exactly the original bytes.
 */
export const TASKS_SCRIPT_INIT = `ui.onReady(async () => {
  if (!ui.ctx().projectId) {
    $("msg").textContent = "プロジェクトがありません。先にプロジェクトを作成してください。";
    return;
  }
  await ui.members();
  const stData = await ui.api(ui.projectPath() + "/workflow/statuses");
  statusDefs = stData.statuses || [];
  const prData = await ui.api(ui.projectPath() + "/workflow/priorities");
  priorityDefs = prData.priorities || [];
  const lbData = await ui.api(ui.projectPath() + "/labels");
  labelDefs = lbData.labels || [];
  buildChecks("fStatuses", statusDefs);
  buildChecks("fPriorities", priorityDefs);
  ui.fillSelect($("cStatus"), statusDefs, (d) => d.slug, (d) => d.name);
  ui.fillSelect($("cPriority"), priorityDefs, (d) => d.slug, (d) => d.name);
  await memberOptions($("fAssignee"), true, "すべての担当");
  await memberOptions($("cAssignee"), false);
  const labelSel = $("fLabel");
  labelSel.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = ""; allOpt.textContent = "すべてのラベル";
  labelSel.appendChild(allOpt);
  for (const l of labelDefs) {
    const o = document.createElement("option");
    o.value = l.id; o.textContent = l.name;
    labelSel.appendChild(o);
  }
  $("fApply").onclick = () => loadTasks().catch((e) => { $("msg").textContent = e.message; });
  $("fQ").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); loadTasks().catch((e) => { $("msg").textContent = e.message; }); } });
  $("createForm").onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const body = {
        title: $("cTitle").value,
        status: $("cStatus").value,
        priority: $("cPriority").value,
        assignee_account_id: $("cAssignee").value || null,
        start_date: $("cStart").value || null,
        due_date: $("cDue").value || null,
        estimate_minutes: $("cEstimate").value === "" ? null : Number($("cEstimate").value),
      };
      const r = await ui.api(ui.projectPath() + "/tasks", ui.jsonOpts("POST", body));
      $("cTitle").value = "";
      await loadTasks();
      await selectTask(r.task.id);
      ui.toast("タスクを作成しました");
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("editForm").onsubmit = async (ev) => {
    ev.preventDefault();
    if (!selectedTask) return;
    try {
      const body = {
        title: $("eTitle").value,
        status: $("eStatus").value,
        priority: $("ePriority").value,
        assignee_account_id: $("eAssignee").value || null,
        parent_task_id: $("eParent").value || null,
        start_date: $("eStart").value || null,
        due_date: $("eDue").value || null,
        estimate_minutes: $("eEstimate").value === "" ? null : Number($("eEstimate").value),
        estimate_points: $("ePoints").value === "" ? null : Number($("ePoints").value),
        estimate_size: $("eSize").value || null,
      };
      const r = await ui.api(ui.projectPath() + "/tasks/" + selectedTask.id, ui.jsonOpts("PATCH", body));
      const idx = taskCache.findIndex((x) => x.id === r.task.id);
      if (idx >= 0) taskCache[idx] = r.task;
      fillDetail(r.task);
      renderList();
      $("msg").textContent = "";
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("dDescSave").onclick = async () => {
    if (!selectedTask) return;
    try {
      const text = $("eDesc").value;
      const enc = text ? await ui.encryptText(text) : null;
      const r = await ui.api(ui.projectPath() + "/tasks/" + selectedTask.id, ui.jsonOpts("PATCH", { description_enc: enc }));
      selectedTask = r.task;
      const idx = taskCache.findIndex((x) => x.id === r.task.id);
      if (idx >= 0) taskCache[idx] = r.task;
      $("descNote").textContent = "保存しました";
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("dDelete").onclick = async () => {
    if (!selectedTask) return;
    if (!confirm("タスク「" + selectedTask.title + "」を削除しますか？")) return;
    try {
      await ui.api(ui.projectPath() + "/tasks/" + selectedTask.id, { method: "DELETE" });
      selectedId = null;
      selectedTask = null;
      $("detail").hidden = true;
      await loadTasks();
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("dTimer").onclick = async () => {
    if (!selectedTask) return;
    const stopping = $("dTimer").textContent === "タイマー停止";
    try {
      if (stopping) {
        await ui.api(ui.tenantPath() + "/timer/stop", ui.jsonOpts("POST"));
      } else {
        await ui.api(ui.tenantPath() + "/timer/start", ui.jsonOpts("POST", { task_id: selectedTask.id }));
      }
      await ui.refreshTimerChip();
      await loadDetailExtras(selectedTask);
      ui.toast(stopping ? "タイマーを停止しました" : "タイマーを開始しました");
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("subAdd").onclick = async () => {
    if (!selectedTask) return;
    const title = $("subTitle").value.trim();
    if (!title) return;
    try {
      await ui.api(ui.projectPath() + "/tasks", ui.jsonOpts("POST", { title, parent_task_id: selectedTask.id }));
      $("subTitle").value = "";
      await loadTasks();
      await loadDetailExtras(selectedTask);
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("depAdd").onclick = async () => {
    if (!selectedTask || !$("depSelect").value) return;
    try {
      await ui.api(ui.projectPath() + "/dependencies", ui.jsonOpts("POST", { task_id: selectedTask.id, depends_on_task_id: $("depSelect").value }));
      await loadDetailExtras(selectedTask);
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("commentPost").onclick = async () => {
    if (!selectedTask) return;
    const text = $("commentBody").value.trim();
    if (!text) return;
    try {
      const enc = await ui.encryptText(text);
      await ui.api(ui.projectPath() + "/tasks/" + selectedTask.id + "/comments", ui.jsonOpts("POST", { body_enc: enc }));
      $("commentBody").value = "";
      await renderComments(selectedTask);
    } catch (e) { $("msg").textContent = e.message; }
  };
  $("vaultSlot").innerHTML = VAULT_HTML;
  await initVaultPanel(ui);
  await loadTasks();
});
`;
