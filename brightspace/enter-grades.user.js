// ==UserScript==
// @name         Brightspace Enter Grades Helpers
// @namespace    https://github.com/nyumathclinic/edubag-userscripts
// @version      0.1.0
// @description  On a grade item's Enter Grades page: set blank grades to zero with a comment, and give kudos to students at full marks.
// @author       Matthew Leingang
// @match        https://*/d2l/lms/grades/admin/enter/grade_item_edit.d2l*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const KUDOS = [
    'Very good! 🔥',
    'Splendid! ✨',
    'Super! 🕺',
    'Sweet! 🍰',
    'Way to go! 🙌',
    'Felicitations! 🎉',
    'Bravo!🦕',
    'Wow! 😎',
    'You did it! 🎉',
    'Amazing work! 🌟',
    'Well done! 👏',
    'Fantastic effort! 💪',
    'You nailed it! 🔨',
    'Bravo! 🎊',
    "You're unstoppable! 🚀",
    'Great job! 🥳',
    'Outstanding! 🏆',
    'Keep shining! ✨',
    "You're a star! 🌟",
  ];
  const BLANK_COMMENT = 'Not submitted';

  const orgUnitId = new URLSearchParams(location.search).get('ou');

  // ---------------------------------------------------------------------------
  // Grades API
  // ---------------------------------------------------------------------------

  // Brightspace's own REST API, called with the page's session. Requests
  // that change anything need the XSRF token the page keeps in localStorage.

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'X-Csrf-Token': localStorage.getItem('XSRF.Token') ?? '',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404 && method === 'GET') return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  let version = null;
  async function gradeValueUrl(gradeObjectId, userId) {
    version ??= (await api('GET', '/d2l/api/le/versions/'))?.LatestVersion;
    if (!version) throw new Error('could not find the Brightspace API version');
    return `/d2l/api/le/${version}/${orgUnitId}/grades/${gradeObjectId}/values/${userId}`;
  }

  // The student's grade as saved, or null if there is none.
  const getGrade = async (gradeObjectId, userId) => api('GET', await gradeValueUrl(gradeObjectId, userId));

  // Private feedback is sent back unchanged; the API replaces both.
  async function putGrade(gradeObjectId, userId, saved, points, commentsHtml) {
    await api('PUT', await gradeValueUrl(gradeObjectId, userId), {
      GradeObjectType: saved?.GradeObjectType ?? 1,
      PointsNumerator: points,
      Comments: { Content: commentsHtml, Type: 'Html' },
      PrivateComments: { Content: saved?.PrivateComments?.Html ?? '', Type: 'Html' },
    });
  }

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const prepend = (text, html) => `<p>${escapeHtml(text)}</p>${html ?? ''}`;

  // ---------------------------------------------------------------------------
  // The grid
  // ---------------------------------------------------------------------------

  // One entry per student row with a numeric grade:
  //   checkbox   input[name=gs_cb], aria-label "Select <name>"
  //   IDs        hidden input u_<userId>_g_<gradeObjectId>_exempt (value True/False)
  //   grade      d2l-input-number, followed in its cell by " / <max>"
  function rows() {
    return [...document.querySelectorAll('input[name="gs_cb"]')].flatMap((checkbox) => {
      const tr = checkbox.closest('tr');
      const ids = tr?.querySelector('input[type=hidden][name^="u_"][name$="_exempt"]');
      const input = tr?.querySelector('d2l-input-number');
      const m = ids?.name.match(/^u_(\d+)_g_(\d+)_exempt$/);
      if (!m || !input) return [];
      const max = input.closest('td')?.textContent.match(/\/\s*(-?\d+(?:\.\d+)?)/)?.[1];
      let value = input.value;
      if (value === undefined) value = document.getElementById(input.dataset.hiddenId)?.value;
      const grade = value === null || value === '' || value === undefined || Number.isNaN(Number(value)) ? null : Number(value);
      return [{
        checkbox,
        name: checkbox.getAttribute('aria-label')?.replace(/^Select /, '') ?? `user ${m[1]}`,
        userId: m[1],
        gradeObjectId: m[2],
        exempt: ids.value === 'True',
        grade,
        max: max === undefined ? null : Number(max),
      }];
    });
  }

  // Check exactly the given rows, through the checkboxes' own click handlers
  // so the grid's selection follows.
  function select(chosen) {
    for (const row of rows()) {
      const want = chosen.some((c) => c.userId === row.userId);
      if (row.checkbox.checked !== want) row.checkbox.click();
    }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  // Each action picks its rows, then for each one decides from the saved
  // grade what to write: { points, comments } or { skip: reason }.
  const ACTIONS = {
    blanks: {
      label: 'Set Blanks to Zero',
      icon: 'tier1:grade',
      description: 'Set every blank grade to zero, with a comment',
      title: 'Set blank grades to zero',
      pick: (all) => all.filter((r) => r.grade === null && !r.exempt),
      none: 'No student on this page has a blank grade (exempt students are left out).',
      comment: true,
      plan: (saved, row, comment) => {
        if (saved?.PointsNumerator != null) return { skip: `already has a saved grade of ${saved.PointsNumerator}` };
        return { points: 0, comments: comment ? prepend(comment, saved?.Comments?.Html) : saved?.Comments?.Html ?? '' };
      },
    },
    kudos: {
      label: 'Give Kudos',
      icon: 'tier1:feedback',
      description: 'Add a congratulatory comment for every student at full marks',
      title: 'Give kudos for full marks',
      pick: (all) => all.filter((r) => r.grade !== null && r.max !== null && r.grade >= r.max),
      none: 'No student on this page has full marks.',
      comment: false,
      plan: (saved, row) => {
        if (saved?.PointsNumerator == null) return { skip: 'has no saved grade' };
        if (saved.PointsNumerator < row.max) return { skip: `saved grade is ${saved.PointsNumerator}, below full marks` };
        const existing = `${saved.Comments?.Text ?? ''}${saved.Comments?.Html ?? ''}`;
        if (KUDOS.some((k) => existing.includes(k) || existing.includes(escapeHtml(k)))) return { skip: 'already has kudos' };
        const kudos = KUDOS[Math.floor(Math.random() * KUDOS.length)];
        return { points: saved.PointsNumerator, comments: prepend(kudos, saved.Comments?.Html), note: kudos };
      },
    },
  };

  async function apply(action, chosen, comment, say) {
    let changed = 0;
    for (const row of chosen) {
      const saved = await getGrade(row.gradeObjectId, row.userId);
      const plan = action.plan(saved, row, comment);
      if (plan.skip) {
        say(`– ${row.name}: skipped, ${plan.skip}`);
        continue;
      }
      await putGrade(row.gradeObjectId, row.userId, saved, plan.points, plan.comments);
      changed++;
      say(`✓ ${row.name}${plan.note ? `: ${plan.note}` : ''}`);
    }
    return changed;
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function openDialog(action) {
    const all = rows();
    const chosen = action.pick(all);
    select(chosen);

    // In a shadow root so Brightspace's stylesheet does not reach the dialog.
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).innerHTML = `
      <dialog style="max-width:520px;width:90vw;padding:16px;border:1px solid #999;border-radius:6px;font:14px/1.4 sans-serif">
        <h3 style="margin:0 0 12px"></h3>
        <label data-role="comment-row" style="display:block;margin-bottom:8px">Comment
          <input type="text" data-role="comment" style="width:100%;box-sizing:border-box">
        </label>
        <pre data-role="status" style="white-space:pre-wrap;max-height:300px;overflow:auto;margin:12px 0;font-size:12px"></pre>
        <div style="text-align:right">
          <button type="button" data-role="cancel">Close</button>
          <button type="button" data-role="apply">Save</button>
        </div>
      </dialog>`;
    const dialog = host.shadowRoot.querySelector('dialog');
    dialog.querySelector('h3').textContent = action.title;
    const comment = dialog.querySelector('[data-role=comment]');
    const status = dialog.querySelector('[data-role=status]');
    const applyButton = dialog.querySelector('[data-role=apply]');
    const say = (line) => {
      status.textContent += `${line}\n`;
      status.scrollTop = status.scrollHeight;
    };

    if (action.comment) comment.value = BLANK_COMMENT;
    else dialog.querySelector('[data-role=comment-row]').remove();

    const ids = new Set(all.map((r) => r.gradeObjectId));
    if (!orgUnitId || ids.size !== 1) {
      say('Could not work out which course and grade item this page is for, so nothing can be saved.');
      applyButton.disabled = true;
    } else if (!chosen.length) {
      say(action.none);
      applyButton.disabled = true;
    } else {
      say(`${chosen.length} student(s), selected in the grid:`);
      chosen.forEach((r) => say(`  ${r.name}`));
      say('\nOnly students shown on this page are included. Saving happens at once, '
        + 'then the page reloads: unsaved edits on this page will be lost.');
    }

    applyButton.addEventListener('click', async () => {
      applyButton.disabled = true;
      comment.disabled = true;
      say('');
      let changed;
      try {
        changed = await apply(action, chosen, comment.value.trim(), say);
      } catch (e) {
        say(`\nStopped: ${e.message}\nEverything marked ✓ above was saved; the rest was not. Reload the page to see the current grades.`);
        return;
      }
      if (!changed) {
        say('\nNothing to change.');
        return;
      }
      say(`\nSaved ${changed}. Reloading…`);
      location.reload();
    });

    dialog.querySelector('[data-role=cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => host.remove());
    document.body.append(host);
    dialog.showModal();
  }

  // A subtle button like the grid's own Set Grades, Clear Grades, ...
  function actionButton(action) {
    const b = document.createElement('d2l-button-subtle');
    b.dataset.enterGradesHelper = '';
    b.setAttribute('icon', action.icon);
    b.setAttribute('text', action.label);
    b.setAttribute('description', action.description);
    b.setAttribute('type', 'button');
    b.addEventListener('click', () => openDialog(action));
    return b;
  }

  // Add the buttons to the grid's action bar, after Brightspace's own.
  function addButtons() {
    const group = document.querySelector('d2l-button-subtle[text="Set Grades"]')?.closest('d2l-overflow-group');
    if (!group || group.querySelector('[data-enter-grades-helper]') || !rows().length) return;
    group.append(actionButton(ACTIONS.blanks), actionButton(ACTIONS.kudos));
  }

  addButtons();
  // The grid may render, or re-render, after the page loads.
  new MutationObserver(addButtons).observe(document.body, { childList: true, subtree: true });
})();
