/**
 * State and small helpers for the /app/tasks inline script.
 *
 * One section of the former inline TASKS_SCRIPT (split for
 * maintainability, KAZAMI-345). The sections are concatenated
 * in order by ./index.ts and the result is byte-identical to
 * the original single script, so page behaviour is unchanged.
 */
export const TASKS_SCRIPT_STATE = `
const ui = window.KosuUI;
const $ = ui.$;
let statusDefs = [];
let priorityDefs = [];
let labelDefs = [];
let taskCache = [];
let selectedId = null;
let selectedTask = null;

function defName(defs, slug) {
  const d = defs.find((x) => x.slug === slug);
  return d ? d.name : slug;
}
function checkedValues(containerId) {
  return Array.from(document.querySelectorAll("#" + containerId + " input[type=checkbox]:checked")).map((el) => el.value);
}
function buildChecks(containerId, defs) {
  const box = $(containerId);
  box.innerHTML = "";
  for (const d of defs) {
    const label = document.createElement("label");
    label.style.marginRight = ".6rem";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = d.slug;
    input.checked = true;
    label.append(input, document.createTextNode(" " + d.name));
    box.appendChild(label);
  }
}
function memberOptions(sel, includeAny, anyLabel) {
  sel.innerHTML = "";
  if (includeAny) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = anyLabel || "すべて";
    sel.appendChild(o);
  }
  const none = document.createElement("option");
  none.value = ""; none.textContent = includeAny ? "" : "（未割当）";
  if (!includeAny) sel.appendChild(none);
  return ui.members().then((ms) => {
    for (const m of ms) {
      const o = document.createElement("option");
      o.value = m.account_id;
      o.textContent = m.display_name || m.email || m.account_id;
      sel.appendChild(o);
    }
  });
}
`;
