// ==UserScript==
// @name         Gradescope Bubble Sheet Answer Key
// @namespace    https://github.com/nyumathclinic/edubag-userscripts
// @version      0.2.2
// @description  Fill in a bubble sheet assignment's answer key (every version) from CSV files, and export it back out. After gradescope-bubbler by Julius Damarackas.
// @author       Matthew Leingang
// @match        https://www.gradescope.com/courses/*/assignments/*/bubble_sheet_answer_key/edit
// @match        https://www.gradescope.com/courses/*/assignment_containers/*/bubble_sheet_answer_key/edit
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Replaces gradescope-bubbler (https://github.com/nyumathclinic/gradescope-bubbler,
  // archived), keeping its CSV format and page automation. The script clicks
  // the answer-key editor the way a person would and never saves; the user
  // reviews the page and clicks Save.

  const LETTERS = 'ABCDE';
  const SEPARATORS = ' ,;';
  const TIMEOUT_MS = 8000;
  // How long the page must go without DOM changes to count as re-rendered.
  const SETTLE_MS = 250;

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

  const csvField = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const toCsv = (rows) => rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';

  const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

  // Port of gradescope_bubbler.answer_key.parse. Returns { rows, errors },
  // rows being [{ question, letters, points, type }].
  function parseKey(text) {
    const [header, ...records] = parseCsv(text.replace(/^﻿/, ''));
    const columns = header?.fields ?? [];
    const errors = [];
    if (!columns.includes('Question')) errors.push("missing 'Question' column");
    if (!columns.includes('Answers') && !columns.includes('Answer')) errors.push("missing 'Answers' column");
    if (errors.length) return { rows: [], errors };

    const rows = [];
    const seen = new Set();
    for (const { fields, line } of records) {
      const record = Object.fromEntries(columns.map((name, i) => [name, fields[i] ?? '']));
      const q = (record.Question ?? '').trim();
      const ans = (record.Answers || record.Answer || '').trim();
      const points = (record.Points ?? '').trim();
      const type = (record.Type ?? '').trim();
      if (!q) continue;
      if (seen.has(q)) {
        errors.push(`line ${line}: question ${q} appears more than once`);
        continue;
      }
      seen.add(q);

      const letters = [];
      let invalid = false;
      for (const c of ans.toUpperCase()) {
        if (SEPARATORS.includes(c)) continue;
        if (!LETTERS.includes(c)) {
          invalid = true;
          break;
        }
        if (!letters.includes(c)) letters.push(c);
      }
      if (invalid) {
        errors.push(`line ${line}: question ${q} has invalid answer '${ans}' (use letters A-E)`);
        continue;
      }
      if (!letters.length) {
        errors.push(`line ${line}: question ${q} has no answer`);
        continue;
      }
      if (points && !NUMBER.test(points)) {
        errors.push(`line ${line}: question ${q} has non-numeric points '${points}'`);
        continue;
      }
      rows.push({ question: q, letters, points, type });
    }
    return { rows, errors };
  }

  function summarize(rows) {
    const withPoints = rows.filter((r) => r.points);
    const lines = [`${rows.length} question(s)`];
    if (withPoints.length) {
      const total = withPoints.reduce((sum, r) => sum + Number(r.points), 0);
      const rest = withPoints.length < rows.length ? `; ${rows.length - withPoints.length} other question(s) keep their current points` : '';
      lines.push(`Points total ${total}${rest}`);
    } else {
      lines.push('Points: unchanged');
    }
    const types = [...new Set(rows.map((r) => r.type).filter(Boolean))];
    lines.push(types.length ? `Scoring type(s): ${types.join(', ')}` : 'Scoring types: unchanged');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // The answer-key editor
  // ---------------------------------------------------------------------------

  // Gradescope's markup, as gradescope-bubbler's filler.py relied on it:
  //   bubble checkbox   #question_{q}_{L}, clicked through label[for=...]
  //   settings button   .fa-gear in the fieldset holding #question_{q}_A
  //   points field      #num-points-q{q}, inside a .jBox-content popup
  //   scoring type      a button in that popup whose text is the type
  const bubble = (q, letter) => document.getElementById(`question_${q}_${letter}`);
  const bubbleLabel = (q, letter) => document.querySelector(`label[for="${CSS.escape(`question_${q}_${letter}`)}"]`);
  const pointsField = (q) => document.getElementById(`num-points-q${q}`);
  const gearFor = (q) => bubble(q, 'A')?.closest('fieldset')?.querySelector('.fa-gear');

  const BUBBLE_ID = /^question_(.+)_([A-E])$/;

  // Question numbers on the page, in page order.
  function pageQuestions() {
    const questions = [];
    for (const input of document.querySelectorAll('input[id^="question_"]')) {
      const m = input.id.match(BUBBLE_ID);
      if (m && !questions.includes(m[1])) questions.push(m[1]);
    }
    return questions;
  }

  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(check, what) {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const result = check();
      if (result) return result;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await pause(50);
    }
  }

  // Problems that would stop the fill partway, found before anything is clicked.
  function checkAgainstPage(rows) {
    const problems = [];
    for (const { question: q, letters, points, type } of rows) {
      if (!bubble(q, 'A')) {
        problems.push(`Q${q} is not on this page`);
        continue;
      }
      for (const letter of letters) {
        if (!bubble(q, letter)) problems.push(`Q${q} has no bubble ${letter} on this page`);
      }
      if ((points || type) && !gearFor(q)) problems.push(`Q${q} has no settings button on this page`);
    }
    return problems;
  }

  async function setBubbles(q, letters) {
    for (const letter of LETTERS) {
      const box = bubble(q, letter);
      if (!box) continue;
      const want = letters.includes(letter);
      if (box.checked === want) continue;
      (bubbleLabel(q, letter) ?? box).click();
      await pause(0);
      if (box.checked !== want) throw new Error(`Q${q}: could not ${want ? 'check' : 'uncheck'} bubble ${letter}`);
    }
  }

  // Set the value so that both plain listeners and React notice the change.
  function setValue(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function setSettings(q, points, type) {
    const gear = gearFor(q);
    gear.click();
    const field = await waitFor(() => (visible(pointsField(q)) ? pointsField(q) : null), `Q${q}'s settings`);
    if (points) setValue(field, points);
    if (type) {
      const popup = field.closest('.jBox-content') ?? field.parentElement;
      const button = [...popup.querySelectorAll('button')].find((b) => b.textContent.trim() === type);
      if (!button) throw new Error(`Q${q}: no scoring type "${type}" in the settings`);
      button.click();
    }
    gear.click();
    await waitFor(() => !visible(pointsField(q)), `Q${q}'s settings to close`);
  }

  async function fill(rows, log) {
    for (const { question: q, letters, points, type } of rows) {
      await setBubbles(q, letters);
      if (points || type) await setSettings(q, points, type);
      log(`  ✓ Q${q}: ${letters.join('')}`);
    }
  }

  const checkedLetters = (q) => [...LETTERS].filter((letter) => bubble(q, letter)?.checked).join('');

  // Rows whose bubbles on the page differ from the key.
  const mismatches = (rows) => rows
    .filter(({ question: q, letters }) => checkedLetters(q) !== letters.join(''))
    .map(({ question: q, letters }) => `Q${q}: page has ${checkedLetters(q) || 'nothing'}, key has ${letters.join('')}`);

  // ---------------------------------------------------------------------------
  // Versions
  // ---------------------------------------------------------------------------

  // A bubble sheet has up to five versions, each a tab in the version
  // switcher (the "Add Version" button there is not a tab). Every version
  // uses the same bubble IDs; switching tabs re-renders the editor.
  function versions() {
    const tabs = [...document.querySelectorAll('#version-switcher-tablist [role="tab"]')];
    if (!tabs.length) return [{ name: 'Answer key', tab: null }];
    return tabs.map((tab) => ({ name: tab.textContent.trim(), tab }));
  }

  const isSelected = (tab) => !tab || tab.getAttribute('aria-selected') === 'true';
  const currentVersion = () => versions().find((v) => isSelected(v.tab));

  // Resolves once the page has gone SETTLE_MS without DOM changes (or after
  // TIMEOUT_MS regardless).
  function settled() {
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(deadline);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, SETTLE_MS);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      timer = setTimeout(done, SETTLE_MS);
      const deadline = setTimeout(done, TIMEOUT_MS);
    });
  }

  async function selectVersion({ name, tab }) {
    if (!tab) return;
    // Look the tab up each time: the switcher re-renders its tabs, and a
    // detached old tab keeps its old aria-selected.
    const fresh = () => versions().find((v) => v.name === name)?.tab;
    if (!fresh()) throw new Error(`${name} is no longer on the page`);
    if (isSelected(fresh())) return;
    fresh().click();
    await waitFor(() => isSelected(fresh()), `${name} to open`);
    await settled();
  }

  // Fill each version that has a key, then go back and check every one,
  // in case switching versions discards unsaved changes.
  async function fillVersions(keys, log) {
    const start = currentVersion() ?? keys[0].version;
    const problems = [];
    for (const { version, rows } of keys) {
      await selectVersion(version);
      problems.push(...checkAgainstPage(rows).map((p) => `${version.name}: ${p}`));
    }
    if (problems.length) {
      await selectVersion(start);
      log(`${problems.length} problem(s), nothing was filled in:`);
      problems.forEach((p) => log(`  ${p}`));
      return false;
    }

    for (const { version, rows } of keys) {
      await selectVersion(version);
      log(`${version.name}:`);
      await fill(rows, log);
    }

    if (keys.length === 1) return true;
    log('\nChecking each version...');
    let ok = true;
    for (const { version, rows } of keys) {
      await selectVersion(version);
      const wrong = mismatches(rows);
      if (!wrong.length) {
        log(`  ✓ ${version.name} matches its key`);
        continue;
      }
      ok = false;
      log(`  ✗ ${version.name} does not match its key:`);
      wrong.forEach((w) => log(`      ${w}`));
    }
    if (!ok) {
      log('\nSwitching versions seems to discard unsaved changes. Fill in one version at a time, saving after each.');
    }
    return ok;
  }

  function exportKey() {
    // Questions with no bubble checked are left out, since a key row needs
    // an answer. The scoring type isn't exported: how the page marks the
    // selected one is unknown.
    const rows = [['Question', 'Answers', 'Points', 'Type']];
    for (const q of pageQuestions()) {
      const answers = checkedLetters(q);
      if (answers) rows.push([q, answers, pointsField(q)?.value ?? '', '']);
    }
    const slug = currentVersion().name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    download(`${slug === 'answer-key' ? slug : `answer-key-${slug}`}.csv`, toCsv(rows));
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function download(filename, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function openFillDialog() {
    const all = versions();
    // In a shadow root so Gradescope's stylesheet does not reach the dialog.
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).innerHTML = `
      <dialog style="max-width:560px;width:90vw;padding:16px;border:1px solid #999;border-radius:6px;font:14px/1.4 sans-serif">
        <h3 style="margin:0 0 12px">Fill in the answer key from CSV</h3>
        <p style="margin:0 0 8px">Choose a file for each version to fill in. Versions without a file are left alone.</p>
        <div data-role="files" style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:center"></div>
        <pre data-role="status" style="white-space:pre-wrap;max-height:300px;overflow:auto;margin:12px 0;font-size:12px"></pre>
        <div style="text-align:right">
          <button type="button" data-role="cancel">Close</button>
          <button type="button" data-role="fill" disabled>Fill</button>
        </div>
      </dialog>`;
    const dialog = host.shadowRoot.querySelector('dialog');
    const files = dialog.querySelector('[data-role=files]');
    const status = dialog.querySelector('[data-role=status]');
    const fillButton = dialog.querySelector('[data-role=fill]');
    const say = (line) => {
      status.textContent += `${line}\n`;
      status.scrollTop = status.scrollHeight;
    };

    // name -> { rows, errors } for each version with a file chosen.
    const parsed = new Map();
    const inputs = all.map((version) => {
      const label = document.createElement('label');
      label.textContent = version.name;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      input.dataset.version = version.name;
      input.setAttribute('aria-label', `CSV file for ${version.name}`);
      files.append(label, input);
      input.addEventListener('change', async () => {
        const file = input.files[0];
        if (file) parsed.set(version.name, parseKey(await file.text()));
        else parsed.delete(version.name);
        refresh();
      });
      return input;
    });

    function refresh() {
      status.textContent = '';
      let valid = parsed.size > 0;
      for (const { name } of all) {
        const result = parsed.get(name);
        if (!result) continue;
        if (result.errors.length) {
          valid = false;
          say(`${name}: ${result.errors.length} problem(s)`);
          result.errors.forEach((e) => say(`  ${e}`));
        } else {
          say(`${name}: ${summarize(result.rows).replace(/\n/g, '\n  ')}`);
        }
      }
      if (parsed.size && !valid) say('\nNothing will be filled in until every chosen file is fixed.');
      if (valid) say('\nBubbles not in a key will be unchecked.');
      fillButton.disabled = !valid;
    }

    fillButton.addEventListener('click', async () => {
      fillButton.disabled = true;
      inputs.forEach((input) => { input.disabled = true; });
      const keys = all.filter((v) => parsed.has(v.name)).map((version) => ({ version, rows: parsed.get(version.name).rows }));
      say('');
      let ok;
      try {
        ok = await fillVersions(keys, say);
      } catch (e) {
        say(`\nStopped: ${e.message}\nQuestions marked ✓ above were filled in; the rest were not. Nothing has been saved.`);
        return;
      }
      if (ok) say('\nDone. Review each version, then click Save Answer Key.');
      else inputs.forEach((input) => { input.disabled = false; });
    });

    dialog.querySelector('[data-role=cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => host.remove());
    document.body.append(host);
    dialog.showModal();
  }

  // An action-bar button, styled like Gradescope's own.
  function actionButton(label, icon, onClick) {
    const li = document.createElement('li');
    li.dataset.bubbleSheetKey = '';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tiiBtn tiiBtn-secondary actionBar--action';
    b.innerHTML = `<span><i class="fa ${icon}" role="img" aria-hidden="true"></i><span></span></span>`;
    b.querySelector('span span').textContent = ` ${label}`;
    b.addEventListener('click', onClick);
    li.append(b);
    return li;
  }

  // Put Fill from CSV / Export CSV in the action bar, before Save Answer Key.
  function addButtons() {
    const list = document.querySelector('#actionBar .actionBar--actionList');
    if (!list || list.querySelector('[data-bubble-sheet-key]')) return;
    const save = list.querySelector('.tiiBtn-primary')?.closest('li') ?? null;
    list.insertBefore(actionButton('Fill from CSV', 'fa-upload', openFillDialog), save);
    list.insertBefore(actionButton('Export CSV', 'fa-download', exportKey), save);
  }

  addButtons();
  // The action bar may render, or re-render, after the page loads.
  new MutationObserver(addButtons).observe(document.body, { childList: true, subtree: true });
})();
