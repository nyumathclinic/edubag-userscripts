// ==UserScript==
// @name         Gradescope Rubric Import/Export
// @namespace    https://github.com/nyumathclinic/gradescope-tampermonkey
// @version      0.5.0
// @description  Import a question's rubric (items, groups, settings) from a JSON file, and export it back out.
// @author       Matthew Leingang
// @match        https://www.gradescope.com/courses/*/questions/*/submissions/*/grade
// @match        https://www.gradescope.com/courses/*/assignments/*/rubric/edit
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Log every non-GET request the page makes to Gradescope and add a "Copy
  // debug log" button, for working out the endpoints if they change.
  const DEBUG = false;

  const SETTINGS_KEYS = ['scoring_type', 'floor', 'ceiling'];
  const SCORING_TYPES = ['positive', 'negative'];

  const courseId = location.pathname.match(/^\/courses\/(\d+)/)[1];
  // The grading view is for one question; the Create Rubric page shows them all.
  const gradePage = location.pathname.match(/\/questions\/(\d+)\/submissions\/\d+\/grade/);

  // ---------------------------------------------------------------------------
  // Endpoints
  // ---------------------------------------------------------------------------

  // Gradescope's rubric endpoints are undocumented. These shapes are the ones
  // its own UI was seen sending.

  const itemBody = (item) => ({ description: item.description, weight: String(item.weight) });
  const flag = (on) => (on ? '1' : '0');

  const apiFor = (questionId) => {
    const questionUrl = `/courses/${courseId}/questions/${questionId}`;
    return {
      createItem: (item) => ({ method: 'POST', url: `${questionUrl}/rubric_items`, body: { rubric_item: itemBody(item) } }),
      deleteItem: (id) => ({ method: 'DELETE', url: `${questionUrl}/rubric_items/${id}` }),
      createGroup: (group) => ({
        method: 'POST',
        url: `${questionUrl}/rubric/create_group_with_items`,
        body: { rubric_item_group: { description: group.description }, rubric_items: group.items.map(itemBody) },
      }),
      updateGroup: (id, fields) => ({ method: 'PUT', url: `${questionUrl}/rubric_item_groups/${id}`, body: { id, ...fields } }),
      deleteGroup: (id) => ({ method: 'DELETE', url: `${questionUrl}/rubric_item_groups/${id}` }),
      // All three settings are sent together.
      updateSettings: (settings) => ({
        method: 'POST',
        url: `${questionUrl}/save_grading_options`,
        body: {
          question: {
            id: questionId,
            scoring_type: settings.scoring_type,
            ceiling: flag(settings.ceiling),
            floor: flag(settings.floor),
          },
        },
      }),
    };
  };

  async function send(req) {
    const res = await fetch(req.url, {
      method: req.method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content ?? '',
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${req.method} ${req.url} returned ${res.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Request logger
  // ---------------------------------------------------------------------------

  const requestLog = [];
  const clip = (s) => (typeof s === 'string' && s.length > 2000 ? `${s.slice(0, 2000)}…` : s);

  function describeBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') return clip(body);
    if (body instanceof FormData || body instanceof URLSearchParams) {
      return [...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? clip(v) : '[file]']);
    }
    return `[${body.constructor?.name ?? typeof body}]`;
  }

  // Third-party analytics requests are noise, and large.
  const sameOrigin = (url) => {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch {
      return false;
    }
  };

  function record(entry) {
    requestLog.push(entry);
    console.log('[rubric-import] request:', entry);
  }

  if (DEBUG) {
    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._rubricImport = { via: 'xhr', method: String(method).toUpperCase(), url: String(url) };
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (this._rubricImport && /^content-type$/i.test(name)) this._rubricImport.contentType = value;
      return xhrSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const entry = this._rubricImport;
      if (entry && entry.method !== 'GET' && sameOrigin(entry.url)) {
        entry.body = describeBody(body);
        this.addEventListener('loadend', () => {
          entry.status = this.status;
          try {
            entry.response = clip(this.responseText);
          } catch {
            entry.response = `[${this.responseType}]`;
          }
          record(entry);
        });
      }
      return xhrSend.apply(this, arguments);
    };

    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      const res = await origFetch.apply(this, arguments);
      if (method !== 'GET' && sameOrigin(url)) {
        const entry = {
          via: 'fetch',
          method,
          url,
          contentType: new Headers(init?.headers ?? input?.headers).get('content-type'),
          body: describeBody(init?.body),
          status: res.status,
        };
        res.clone().text().then((t) => { entry.response = clip(t); }, () => {}).finally(() => record(entry));
      }
      return res;
    };
  }

  // ---------------------------------------------------------------------------
  // Reading the current rubric from the page
  // ---------------------------------------------------------------------------

  function pageProps(doc = document) {
    return [...doc.querySelectorAll('[data-react-props]')].flatMap((el) => {
      try {
        return [{ component: el.dataset.reactClass, props: JSON.parse(el.dataset.reactProps) }];
      } catch {
        return [];
      }
    });
  }

  // The page's main component props and its questions that can have a rubric.
  function rubricPage(doc = document) {
    const props = pageProps(doc).find((p) => ['SubmissionGrader', 'AssignmentRubric'].includes(p.component))?.props;
    if (!props) return null;
    const leaves = (questions) => (questions ?? []).flatMap((q) => (q.children?.length ? leaves(q.children) : [q]));
    return { props, questions: props.question ? [props.question] : leaves(props.questions) };
  }

  const findQuestion = (questionId, doc = document) => rubricPage(doc)?.questions.find((q) => q.id === questionId);
  const questionLabel = (q) => `${q.full_index}: ${q.title}`;

  // The page as the server has it now. The props in the live document date
  // from page load and miss any rubric edits made since.
  async function freshDocument() {
    const res = await fetch(location.href, { credentials: 'same-origin', headers: { Accept: 'text/html' } });
    if (!res.ok) throw new Error(`reloading the page data returned ${res.status}`);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  function readRubric(questionId, doc) {
    const { props } = rubricPage(doc) ?? {};
    const question = findQuestion(questionId, doc);
    if (!question || !Array.isArray(props.rubric_items)) return null;
    // The grading view's items carry no question_id; they are all this question's.
    const mine = (entry) => entry.question_id == null || entry.question_id === questionId;
    const rubric = {};
    for (const key of SETTINGS_KEYS) if (key in question) rubric[key] = question[key];
    rubric.rubric_items = props.rubric_items.filter(mine);
    rubric.rubric_item_groups = (props.rubric_item_groups ?? []).filter(mine);
    return rubric;
  }

  // Shape of the page props with values withheld (they include student data
  // and signed file URLs), except under rubric- and scoring-related keys.
  function skeleton(value, revealed = false) {
    if (Array.isArray(value)) {
      const shown = value.slice(0, 2).map((v) => skeleton(v, revealed));
      return value.length > 2 ? [...shown, `… ${value.length} total`] : shown;
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [
        k,
        skeleton(v, revealed || /rubric|scor|floor|ceiling|bound|weight|^urls$/i.test(k)),
      ]));
    }
    return revealed ? clip(value) : typeof value;
  }

  function debugReport() {
    return JSON.stringify({
      page: location.pathname.replace(/\d+/g, ':id'),
      props: pageProps().map((p) => ({ component: p.component, props: skeleton(p.props) })),
      requests: requestLog,
    }, null, 2);
  }

  // ---------------------------------------------------------------------------
  // JSON format
  // ---------------------------------------------------------------------------

  // Accepts the hand-written form (items nested inside their group) and
  // Gradescope's flat form (items carrying a group_id). Returns
  // { rubric: { settings, items, groups: [{..., items}], entries }, errors },
  // where entries is the top-level order: [{ item } | { group }, ...].
  function normalize(data) {
    const errors = [];
    const rubric = { settings: {}, items: [], groups: [], entries: [] };
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { rubric, errors: ['top level: expected an object'] };
    }

    if ('scoring_type' in data) {
      if (SCORING_TYPES.includes(data.scoring_type)) rubric.settings.scoring_type = data.scoring_type;
      else errors.push(`scoring_type: expected one of ${SCORING_TYPES.join(', ')}`);
    }
    for (const key of ['floor', 'ceiling']) {
      if (!(key in data)) continue;
      if (typeof data[key] === 'boolean') rubric.settings[key] = data[key];
      else errors.push(`${key}: expected true or false`);
    }

    const byPosition = (list) => (list.every((x) => typeof x?.position === 'number')
      ? [...list].sort((a, b) => a.position - b.position)
      : list);
    const asList = (value, path) => {
      if (value === undefined) return [];
      if (Array.isArray(value)) return byPosition(value);
      errors.push(`${path}: expected an array`);
      return [];
    };
    const item = (raw, path) => {
      if (raw === null || typeof raw !== 'object') {
        errors.push(`${path}: expected an object`);
        return null;
      }
      if ('rubric_items' in raw || 'rubric_item_groups' in raw) errors.push(`${path}: groups cannot be nested`);
      if (typeof raw.description !== 'string' || !raw.description.trim()) errors.push(`${path}.description: expected non-empty text`);
      if (raw.weight === null || raw.weight === '' || !Number.isFinite(Number(raw.weight))) errors.push(`${path}.weight: expected a number`);
      return { description: raw.description, weight: Number(raw.weight) };
    };

    const groupsById = new Map();
    const topItems = [];
    const topGroups = [];
    asList(data.rubric_item_groups, 'rubric_item_groups').forEach((raw, i) => {
      const path = `rubric_item_groups[${i}]`;
      if (raw === null || typeof raw !== 'object') {
        errors.push(`${path}: expected an object`);
        return;
      }
      if (typeof raw.description !== 'string' || !raw.description.trim()) errors.push(`${path}.description: expected non-empty text`);
      if ('mutually_exclusive' in raw && typeof raw.mutually_exclusive !== 'boolean') errors.push(`${path}.mutually_exclusive: expected true or false`);
      const group = {
        description: raw.description,
        mutually_exclusive: raw.mutually_exclusive === true,
        items: asList(raw.rubric_items, `${path}.rubric_items`)
          .map((it, j) => item(it, `${path}.rubric_items[${j}]`))
          .filter(Boolean),
      };
      rubric.groups.push(group);
      topGroups.push({ position: raw.position, group });
      if (raw.id != null) groupsById.set(String(raw.id), group);
    });

    asList(data.rubric_items, 'rubric_items').forEach((raw, i) => {
      const path = `rubric_items[${i}]`;
      const parsed = item(raw, path);
      if (!parsed) return;
      if (raw.group_id == null) {
        rubric.items.push(parsed);
        topItems.push({ position: raw.position, item: parsed });
      } else if (groupsById.has(String(raw.group_id))) {
        groupsById.get(String(raw.group_id)).items.push(parsed);
      } else {
        errors.push(`${path}.group_id: no group with id ${raw.group_id}`);
      }
    });

    // Ungrouped items and groups share one position sequence. Without a full
    // set of positions, items go first.
    rubric.entries = byPosition([...topItems, ...topGroups]).map(({ item: it, group }) => (it ? { item: it } : { group }));

    rubric.groups.forEach((g) => {
      if (!g.items.length) errors.push(`group "${g.description}": a group needs at least one item`);
    });

    return { rubric, errors };
  }

  function serialize(rubric) {
    // Positions only matter when there are both ungrouped items and groups.
    const mixed = rubric.items.length && rubric.groups.length;
    const position = (entry) => (mixed ? { position: rubric.entries.findIndex((e) => (e.item ?? e.group) === entry) } : {});
    return {
      ...rubric.settings,
      rubric_items: rubric.items.map((it) => ({ ...it, ...position(it) })),
      rubric_item_groups: rubric.groups.map((g) => ({
        description: g.description,
        mutually_exclusive: g.mutually_exclusive,
        ...position(g),
        rubric_items: g.items,
      })),
    };
  }

  function summarize(rubric) {
    const all = [...rubric.items, ...rubric.groups.flatMap((g) => g.items)];
    const lines = [
      `${all.length} rubric item(s), ${rubric.groups.length} group(s)`,
      `Point values sum to ${all.reduce((sum, it) => sum + Number(it.weight), 0)}`,
    ];
    const settings = Object.entries(rubric.settings).map(([k, v]) => `${k} = ${v}`);
    lines.push(settings.length ? `Settings: ${settings.join(', ')}` : 'Settings: unchanged');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Import
  // ---------------------------------------------------------------------------

  async function runImport(question, rubric, existing, log) {
    const api = apiFor(question.id);
    const step = async (label, req) => {
      const json = await send(req);
      log(`✓ ${label}`);
      return json;
    };

    // Settings left out of the file keep the question's current value.
    let settings = null;
    if (Object.keys(rubric.settings).length) {
      settings = { ...question, ...rubric.settings };
      const missing = SETTINGS_KEYS.filter((key) => settings[key] == null);
      if (missing.length) throw new Error(`could not read the question's current ${missing.join(', ')} from the page; give all of ${SETTINGS_KEYS.join(', ')} in the file`);
    }

    if (existing) {
      for (const it of existing.rubric_items) await step(`deleted item "${it.description}"`, api.deleteItem(it.id));
      for (const g of existing.rubric_item_groups) await step(`deleted group "${g.description}"`, api.deleteGroup(g.id));
    }
    if (settings) await step('updated settings', api.updateSettings(settings));
    for (const { item, group } of rubric.entries) {
      if (item) {
        await step(`item "${item.description}"`, api.createItem(item));
        continue;
      }
      const created = await step(`group "${group.description}" with ${group.items.length} item(s)`, api.createGroup(group));
      const groupId = created?.rubric_item_group?.id;
      if (groupId == null) throw new Error(`could not find the new group's id in the response for "${group.description}"`);
      if (created.rubric_items?.length !== group.items.length) throw new Error(`group "${group.description}" was created with ${created.rubric_items?.length ?? 0} of its ${group.items.length} items`);
      if (group.mutually_exclusive) await step('  set to select one', api.updateGroup(groupId, { mutually_exclusive: true }));
    }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function download(filename, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function exportRubric(questionId) {
    let current;
    try {
      current = readRubric(questionId, await freshDocument());
    } catch (e) {
      alert(`Could not export the rubric: ${e.message}`);
      return;
    }
    if (!current) {
      alert('Could not find the rubric in the page data.');
      return;
    }
    const { rubric } = normalize(current);
    download(`rubric-q${questionId}.json`, `${JSON.stringify(serialize(rubric), null, 2)}\n`);
  }

  function openImportDialog(question) {
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'max-width:520px;width:90vw;padding:16px;border:1px solid #999;border-radius:6px;font:14px/1.4 sans-serif';
    dialog.innerHTML = `
      <h3 style="margin:0 0 12px"></h3>
      <input type="file" accept=".json,application/json">
      <pre data-role="status" style="white-space:pre-wrap;max-height:260px;overflow:auto;margin:12px 0;font-size:12px"></pre>
      <label style="display:block;margin-bottom:12px"><input type="checkbox" data-role="replace"> Replace existing rubric</label>
      <div style="text-align:right">
        <button type="button" data-role="cancel">Close</button>
        <button type="button" data-role="import" disabled>Import</button>
      </div>`;
    dialog.querySelector('h3').textContent = `Import rubric into question ${questionLabel(question)}`;
    const fileInput = dialog.querySelector('input[type=file]');
    const status = dialog.querySelector('[data-role=status]');
    const replace = dialog.querySelector('[data-role=replace]');
    const importButton = dialog.querySelector('[data-role=import]');
    const say = (line) => {
      status.textContent += `${line}\n`;
      status.scrollTop = status.scrollHeight;
    };
    let rubric = null;

    fileInput.addEventListener('change', async () => {
      rubric = null;
      importButton.disabled = true;
      status.textContent = '';
      const file = fileInput.files[0];
      if (!file) return;
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch (e) {
        say(`Not valid JSON: ${e.message}`);
        return;
      }
      const result = normalize(data);
      if (result.errors.length) {
        say(`${result.errors.length} problem(s), nothing will be imported:`);
        result.errors.forEach((e) => say(`  ${e}`));
        return;
      }
      rubric = result.rubric;
      say(summarize(rubric));
      importButton.disabled = false;
    });

    importButton.addEventListener('click', async () => {
      importButton.disabled = true;
      let current;
      let existing = null;
      try {
        const doc = await freshDocument();
        current = findQuestion(question.id, doc);
        if (replace.checked) existing = readRubric(question.id, doc);
      } catch (e) {
        say(`Could not read the current rubric: ${e.message}`);
        importButton.disabled = false;
        return;
      }
      if (!current || (replace.checked && !existing)) {
        say('Could not find this question in the page data, so nothing was imported.');
        importButton.disabled = false;
        return;
      }
      if (existing) {
        const ok = confirm(
          `Delete ${existing.rubric_items.length} existing rubric item(s) and ${existing.rubric_item_groups.length} group(s) from this question before importing?\n\n`
          + 'If any of them have been applied to submissions, those grades will change. This cannot be undone.',
        );
        if (!ok) {
          importButton.disabled = false;
          return;
        }
      }
      fileInput.disabled = true;
      replace.disabled = true;
      say('');
      try {
        await runImport(current, rubric, existing, say);
      } catch (e) {
        say(`\nStopped: ${e.message}\nEverything marked ✓ above was done; the rest was not. Reload the page to see the current rubric.`);
        return;
      }
      say('\nDone. Reloading…');
      location.reload();
    });

    dialog.querySelector('[data-role=cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  // A button styled like the ones in Gradescope's rubric action row.
  function jsonButton(label, ariaLabel, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tiiBtn tiiBtn-secondary btnGroup--btn';
    b.dataset.rubricJson = '';
    b.setAttribute('aria-label', ariaLabel);
    b.innerHTML = '<span><i class="fa fa-code" role="img" aria-hidden="true"></i><span></span></span>';
    b.querySelector('span span').textContent = ` ${label}`;
    b.addEventListener('click', onClick);
    return b;
  }

  let loaded = null;
  const questions = () => (loaded ??= rubricPage())?.questions ?? [];

  // Which question an "Add Rubric Item" button belongs to. On the Create
  // Rubric page its label ends in the question's number.
  function questionFor(addItemButton) {
    if (gradePage) return questions().find((q) => q.id === Number(gradePage[1]));
    const index = addItemButton.getAttribute('aria-label')?.match(/question (\S+)$/)?.[1];
    return questions().find((q) => String(q.full_index) === index);
  }

  // Put Import JSON / Export JSON at the end of each rubric's action row,
  // after Gradescope's own "Import...".
  function addButtons() {
    for (const addItemButton of document.querySelectorAll('.btnGroup [data-px="addRubricItem"]')) {
      const row = addItemButton.closest('.btnGroup');
      if (row.querySelector('[data-rubric-json]')) continue;
      const question = questionFor(addItemButton);
      if (!question) continue;
      row.append(
        jsonButton('Import JSON', `Import rubric JSON into question ${question.full_index}`, () => openImportDialog(question)),
        jsonButton('Export JSON', `Export rubric JSON from question ${question.full_index}`, () => exportRubric(question.id)),
      );
    }
  }

  function addDebugButton() {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy debug log';
    copy.style.cssText = 'position:fixed;left:8px;bottom:56px;z-index:10000;font:12px sans-serif';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(debugReport());
      copy.textContent = `Copied (${requestLog.length} requests)`;
    });
    document.body.append(copy);
  }

  function start() {
    addButtons();
    // React re-renders the rows and drops the buttons, so keep them topped up.
    new MutationObserver(addButtons).observe(document.body, { childList: true, subtree: true });
    if (DEBUG) addDebugButton();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
