// ==UserScript==
// @name         Starfish Progress Survey Filler
// @namespace    https://github.com/nyumathclinic/edubag-userscripts
// @version      0.1.0
// @description  Fill in a Starfish progress survey (progress checkbox and comment for each student) from a CSV file keyed by username.
// @author       Matthew Leingang
// @match        https://*.starfishsolutions.com/starfish-ops/student/students.html*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // The script clicks the survey the way a person would and never saves or
  // submits; the user reviews the page and clicks Save, then Submit.
  // Usernames are read from each student's hover card and stay in the page.

  const TIMEOUT_MS = 8000;
  // How long to wait for a student's hover card before giving up on it.
  const CARD_TIMEOUT_MS = 3000;
  // After this many cards in a row fail to show, stop hovering and match
  // the rest by name.
  const MAX_CARD_FAILURES = 3;

  // ---------------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------------

  // RFC 4180 records, each with the (1-based) line it ends on. Fully blank
  // lines are dropped, as Python's csv module does.
  function parseCsv(text) {
    const records = [];
    let record = [];
    let field = '';
    let quoted = false;
    let line = 1;
    const endRecord = () => {
      record.push(field);
      if (record.length > 1 || record[0] !== '') records.push({ fields: record, line });
      record = [];
      field = '';
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (c === '"') {
          quoted = false;
        } else {
          if (c === '\n') line++;
          field += c;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === ',') {
        record.push(field);
        field = '';
      } else if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        endRecord();
        line++;
      } else {
        field += c;
      }
    }
    if (field !== '' || record.length) endRecord();
    return records;
  }

  const NAME_COLUMN = 'Name (Last, First)';

  // Names compared loosely: case, accents and spacing don't count.
  const normalizeName = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();

  // The page's choice that a CSV value names: the one it is a prefix of,
  // ignoring case, so "Concerns" names "Concerns About Progress".
  function matchChoice(value, choices) {
    const v = value.trim().toLowerCase();
    if (!v) return null;
    const found = choices.filter((c) => c.toLowerCase().startsWith(v));
    return found.length === 1 ? found[0] : null;
  }

  // Returns { rows, errors }, rows being [{ username, name, choice, comment, line }].
  function parseSurvey(text, choices) {
    const [header, ...records] = parseCsv(text.replace(/^﻿/, ''));
    const columns = (header?.fields ?? []).map((c) => c.trim());
    const errors = [];
    if (!columns.includes('Username')) errors.push("missing 'Username' column");
    if (!columns.includes('Progress Indicator')) errors.push("missing 'Progress Indicator' column");
    if (errors.length) return { rows: [], errors };

    const rows = [];
    const seen = new Set();
    for (const { fields, line } of records) {
      const record = Object.fromEntries(columns.map((name, i) => [name, fields[i] ?? '']));
      const username = record.Username.trim().toLowerCase();
      const progress = record['Progress Indicator'].trim();
      const comment = (record.Comments ?? '').trim();
      if (!username) continue;
      if (seen.has(username)) {
        errors.push(`line ${line}: ${username} appears more than once`);
        continue;
      }
      seen.add(username);
      if (!progress) {
        errors.push(`line ${line}: ${username} has no progress indicator`);
        continue;
      }
      const choice = matchChoice(progress, choices);
      if (!choice) {
        errors.push(`line ${line}: ${username} has progress '${progress}', which isn't one of: ${choices.join(', ')}`);
        continue;
      }
      rows.push({ username, name: (record[NAME_COLUMN] ?? '').trim(), choice, comment, line });
    }
    return { rows, errors };
  }

  // ---------------------------------------------------------------------------
  // The survey
  // ---------------------------------------------------------------------------

  // Starfish's markup (November 2026). Class names carry build hashes
  // (MainRow__row___Fw5l0), so they're matched by prefix.
  //   student row      tr[class*=MainRow__row]
  //   name link        a.sf-card-trigger, with the student's id in data:card-id
  //   progress box     input[type=checkbox] with id "{card id}-{choice}"
  //   comments row     the tr[class*=DesktopCommentsRow__row] after the student row,
  //                    with a textarea whose id is also "{card id}-{choice}";
  //                    it opens on its own for Concerns, otherwise through
  //                    [aria-label="Toggle comments"] in the student row
  //   hover card       #card-student-{card id}, username in p.username; built
  //                    the first time the name is hovered over
  const surveyRows = () => [...document.querySelectorAll('tr[class*="MainRow__row"]')];
  const nameLink = (tr) => tr.querySelector('a.sf-card-trigger');
  const cardId = (tr) => nameLink(tr)?.getAttribute('data:card-id') ?? null;
  const progressBoxes = (tr) => [...tr.querySelectorAll('input[type="checkbox"]')];
  const choiceOf = (box, id) => box.id.slice(`${id}-`.length);
  const footer = () => document.querySelector('footer[class*="Footer__container"]');

  function commentsRow(tr) {
    const next = tr.nextElementSibling;
    return next && /DesktopCommentsRow__row/.test(next.className) ? next : null;
  }

  // The comment box for the student's choice, or the only one there.
  function commentBox(tr, id, choice) {
    const row = commentsRow(tr);
    if (!row) return null;
    return row.querySelector(`textarea[id="${CSS.escape(`${id}-${choice}`)}"]`) ?? (row.querySelectorAll('textarea').length === 1 ? row.querySelector('textarea') : null);
  }

  // The progress choices the survey offers, from the first row's checkboxes.
  function pageChoices() {
    const tr = surveyRows()[0];
    if (!tr) return [];
    const id = cardId(tr);
    return progressBoxes(tr).map((box) => choiceOf(box, id));
  }

  // [{ tr, id, name }] for each student on the page.
  const students = () => surveyRows().map((tr) => ({ tr, id: cardId(tr), name: nameLink(tr)?.textContent.trim() ?? '' })).filter((s) => s.id);

  const checkedChoice = ({ tr, id }) => progressBoxes(tr).filter((b) => b.checked).map((b) => choiceOf(b, id)).join(', ');

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(check, what, timeout = TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const result = check();
      if (result) return result;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await pause(50);
    }
  }

  // ---------------------------------------------------------------------------
  // Hover cards
  // ---------------------------------------------------------------------------

  function mouse(el, type, relatedTarget = null) {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: type !== 'mouseenter' && type !== 'mouseleave',
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      relatedTarget,
    }));
  }

  // The username on the student's card, if the page has built it. Each
  // student's card is its own element, #card-student-{card id}, and stays
  // in the page once it has been shown.
  const cardUsername = (id) => document.getElementById(`card-student-${id}`)?.querySelector('p.username')?.textContent.trim().toLowerCase() || null;

  // Hovers over the student's name until their card is built, and returns
  // the username on it, or null if it doesn't appear.
  async function hoverForUsername({ tr, id }) {
    const link = nameLink(tr);
    link.scrollIntoView({ block: 'center' });
    mouse(link, 'mouseover', document.body);
    mouse(link, 'mouseenter', document.body);
    mouse(link, 'mousemove');
    try {
      return await waitFor(() => cardUsername(id), 'the hover card', CARD_TIMEOUT_MS);
    } catch {
      return null;
    } finally {
      mouse(link, 'mouseout', document.body);
      mouse(link, 'mouseleave', document.body);
    }
  }

  // Pairs CSV rows with students on the page: by card username, or by name
  // for students whose card wouldn't show. Returns { pairs, report }, pairs
  // being [{ row, student }].
  async function matchStudents(rows, log) {
    const all = students();
    const byUsername = new Map();
    const unread = [];
    let failures = 0;
    for (const [i, student] of all.entries()) {
      let username = cardUsername(student.id);
      if (!username && failures < MAX_CARD_FAILURES) {
        log(`Reading hover cards... ${i + 1}/${all.length}`, true);
        username = await hoverForUsername(student);
        failures = username ? 0 : failures + 1;
      }
      if (username) byUsername.set(username, student);
      else unread.push(student);
    }

    const report = [];
    if (unread.length) {
      report.push(`${unread.length} student(s)' hover cards couldn't be read; they are matched by name instead.`);
    }
    const byName = new Map();
    for (const s of unread) {
      const key = normalizeName(s.name);
      byName.set(key, byName.has(key) ? null : s);
    }

    const pairs = [];
    const matched = new Set();
    for (const row of rows) {
      let student = byUsername.get(row.username);
      if (!student && row.name) {
        student = byName.get(normalizeName(row.name));
        if (student) report.push(`${row.username}: matched by name`);
      }
      if (!student) {
        report.push(`${row.username}: not on this page`);
        continue;
      }
      if (row.name && normalizeName(row.name) !== normalizeName(student.name)) {
        report.push(`${row.username}: CSV name "${row.name}" differs from page name "${student.name}"`);
      }
      matched.add(student);
      pairs.push({ row, student });
    }
    const untouched = all.filter((s) => !matched.has(s));
    if (untouched.length) report.push(`${untouched.length} student(s) on the page aren't in the CSV and will be left alone`);
    return { pairs, report };
  }

  // Problems that would stop the fill, found before anything is clicked.
  function checkPairs(pairs) {
    const problems = [];
    const changes = [];
    for (const { row, student } of pairs) {
      const { tr, id } = student;
      if (!tr.isConnected) {
        problems.push(`${row.username}: the row is no longer on the page`);
        continue;
      }
      if (!tr.querySelector(`input[id="${CSS.escape(`${id}-${row.choice}`)}"]`)) {
        problems.push(`${row.username}: no '${row.choice}' checkbox`);
      }
      const current = checkedChoice(student);
      if (current && current !== row.choice) changes.push(`${row.username}: ${current} → ${row.choice}`);
      // A comment left blank keeps whatever is there, but Concerns needs one.
      const existing = current === row.choice ? commentBox(tr, id, row.choice)?.value.trim() : '';
      if (!row.comment && !existing && /concern/i.test(row.choice)) {
        problems.push(`${row.username}: '${row.choice}' needs a comment`);
      }
    }
    return { problems, changes };
  }

  // ---------------------------------------------------------------------------
  // Filling in
  // ---------------------------------------------------------------------------

  // Set the value so that React notices the change.
  function setValue(textarea, value) {
    textarea.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.blur();
  }

  async function setChoice({ tr, id }, choice) {
    // Clear any other choice first, in case the boxes aren't exclusive.
    for (const box of progressBoxes(tr)) {
      if (box.checked && choiceOf(box, id) !== choice) {
        box.click();
        await waitFor(() => !box.isConnected || !box.checked, `'${choiceOf(box, id)}' to clear`);
      }
    }
    const target = () => tr.querySelector(`input[id="${CSS.escape(`${id}-${choice}`)}"]`);
    if (!target().checked) target().click();
    await waitFor(() => target()?.checked, `'${choice}' to be checked`);
  }

  async function setComment({ tr, id }, choice, comment) {
    if (!commentBox(tr, id, choice)) {
      const toggle = await waitFor(() => tr.querySelector('[aria-label="Toggle comments"]'), 'the Show Comments button');
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    }
    const box = await waitFor(() => commentBox(tr, id, choice), 'the comment box');
    if (box.value !== comment) setValue(box, comment);
  }

  async function fill(pairs, log) {
    for (const { row, student } of pairs) {
      await setChoice(student, row.choice);
      if (row.comment) await setComment(student, row.choice, row.comment);
      log(`  ✓ ${row.username}: ${row.choice}${row.comment ? ' + comment' : ''}`);
    }
  }

  // Rows where the page differs from the CSV.
  function mismatches(pairs) {
    const wrong = [];
    for (const { row, student } of pairs) {
      const current = checkedChoice(student);
      if (current !== row.choice) wrong.push(`${row.username}: page has ${current || 'nothing'}, CSV has ${row.choice}`);
      else if (row.comment && commentBox(student.tr, student.id, row.choice)?.value !== row.comment) wrong.push(`${row.username}: comment doesn't match`);
    }
    return wrong;
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function openFillDialog() {
    // In a shadow root so Starfish's stylesheet does not reach the dialog.
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).innerHTML = `
      <dialog style="max-width:600px;width:90vw;padding:16px;border:1px solid #999;border-radius:6px;font:14px/1.4 sans-serif">
        <h3 style="margin:0 0 12px">Fill in the progress survey from CSV</h3>
        <input type="file" accept=".csv,text/csv" aria-label="Survey CSV file">
        <pre data-role="status" style="white-space:pre-wrap;max-height:340px;overflow:auto;margin:12px 0;font-size:12px"></pre>
        <div style="text-align:right">
          <button type="button" data-role="cancel">Close</button>
          <button type="button" data-role="fill" disabled>Fill</button>
        </div>
      </dialog>`;
    const dialog = host.shadowRoot.querySelector('dialog');
    const input = dialog.querySelector('input');
    const status = dialog.querySelector('[data-role=status]');
    const fillButton = dialog.querySelector('[data-role=fill]');
    // A line said with `replace` overwrites the previous one, for progress.
    let replaceable = false;
    const say = (line, replace = false) => {
      if (replaceable) status.textContent = status.textContent.replace(/[^\n]*\n$/, '');
      status.textContent += `${line}\n`;
      replaceable = replace;
      status.scrollTop = status.scrollHeight;
    };
    const clear = () => {
      status.textContent = '';
      replaceable = false;
    };

    let rows = [];
    const choices = pageChoices();

    input.addEventListener('change', async () => {
      clear();
      fillButton.disabled = true;
      const file = input.files[0];
      if (!file) return;
      const result = parseSurvey(await file.text(), choices);
      rows = result.rows;
      if (result.errors.length) {
        say(`${result.errors.length} problem(s); fix the file and choose it again:`);
        result.errors.forEach((e) => say(`  ${e}`));
        return;
      }
      const counts = choices.map((c) => `${rows.filter((r) => r.choice === c).length} ${c}`).join(', ');
      say(`${rows.length} student(s): ${counts}; ${rows.filter((r) => r.comment).length} with comments.`);
      say('\nFill first reads each student\'s hover card to find their username; leave the mouse still.');
      say('Comments in the CSV replace any already there; blank ones leave them as they are.');
      fillButton.disabled = false;
    });

    // Matches students and checks everything before clicking anything.
    fillButton.addEventListener('click', async () => {
      fillButton.disabled = input.disabled = true;
      say('');
      const { pairs, report } = await matchStudents(rows, say);
      say(`Matched ${pairs.length} of ${rows.length} CSV student(s).`);
      report.forEach((r) => say(`  ${r}`));
      const { problems, changes } = checkPairs(pairs);
      if (problems.length || !pairs.length) {
        if (problems.length) say(`\n${problems.length} problem(s), nothing was filled in:`);
        else say('\nNo one in the CSV is on this page; nothing was filled in.');
        problems.forEach((p) => say(`  ${p}`));
        fillButton.disabled = input.disabled = false;
        return;
      }
      if (changes.length) {
        say(`\n${changes.length} student(s) have a different choice, which is being changed:`);
        changes.forEach((c) => say(`  ${c}`));
      }
      say('');
      try {
        await fill(pairs, say);
      } catch (e) {
        say(`\nStopped: ${e.message}\nStudents marked ✓ above were filled in; the rest were not. Nothing has been saved.`);
        return;
      }
      const wrong = mismatches(pairs);
      if (wrong.length) {
        say(`\n${wrong.length} student(s) don't match the CSV after filling:`);
        wrong.forEach((w) => say(`  ${w}`));
      } else {
        say(`\n✓ All ${pairs.length} student(s) match the CSV.`);
      }
      say('Nothing has been saved. Review the page, click Save, then Submit.');
    });

    dialog.querySelector('[data-role=cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => host.remove());
    document.body.append(host);
    dialog.showModal();
  }

  // Put Fill from CSV in the survey's footer, before Reset, styled like it.
  function addButton() {
    const bar = footer();
    if (!bar || bar.querySelector('[data-progress-survey-filler]') || !surveyRows().length) return;
    const reset = bar.querySelector('button');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.progressSurveyFiller = '';
    b.className = reset?.className ?? '';
    b.innerHTML = '<span><i class="material-icons" aria-hidden="true" data-role="materialIcon">upload_file</i></span>';
    b.querySelector('span').append('Fill from CSV');
    b.addEventListener('click', openFillDialog);
    bar.insertBefore(b, reset);
  }

  addButton();
  // The survey is rendered by the page's router, after the page loads.
  new MutationObserver(addButton).observe(document.body, { childList: true, subtree: true });
})();
