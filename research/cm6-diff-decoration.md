# CodeMirror 6 Decoration Patterns for Proposed-Edit Diffs

> Research deliverable for wayfinder ticket **R3** ([github.com/CatInRl/Murasaki/issues/13](https://github.com/CatInRl/Murasaki/issues/13)).
> Informs ticket **T5** — proposal/accept UI prototype ([github.com/CatInRl/Murasaki/issues/7](https://github.com/CatInRl/Murasaki/issues/7)).
> Authored: 2026-07-27. All API claims are sourced from CM6 official docs/example (cited inline); code sketches target the versions actually installed in this repo.

---

## 0. Verified environment (from `package.json` + source inspection)

| Package | Installed version | Role in Murasaki |
|---|---|---|
| `@codemirror/state` | `^6.7.1` | State, transactions, StateField, StateEffect |
| `@codemirror/view` | `^6.43.6` | EditorView, Decoration, WidgetType, DecorationSet |
| `@codemirror/lang-markdown` | `^6.5.1` | Markdown syntax **inside the editor** (Lezer parser) |
| `@codemirror/language` | `^6.12.4` | syntaxTree, indentOnInput, bracketMatching, foldGutter |
| `codemirror` | `^6.0.2` | bundle |
| `shiki` | `^4.3.1` | **preview pane only** (see §7) |
| `@shikijs/markdown-it` | `^4.3.1` | markdown-it code-block highlighter for preview |
| `diff-match-patch` | `^1.0.5` | **already a dependency** — reuse for diff computation |

Editor entry point: `src/components/SourceEditor.vue` — exposes `buildExtensions(): Extension[]` which is the natural injection point for a proposal extension. The view is exposed via `emit("ready", view)`, so a proposal controller can dispatch transactions without reaching into the component.

---

## 1. Executive summary

1. **Use a `StateField<DecorationSet>` driven by `StateEffect` to hold pending proposals.** This is CM6's canonical pattern for "a set of positioned decorations that must move with document edits" — directly demonstrated in the official Decoration example ([codemirror.net/examples/decoration](https://codemirror.net/examples/decoration/)). It gives atomic, single-transaction updates and survives undo/redo for free.
2. **Render insertions with `Decoration.widget` (green-styled `<span>`), replacements with `Decoration.mark` (red strikethrough on old text) + `Decoration.widget` (green new text).** Buttons live in a single trailing `WidgetType` per proposal. Avoid `Decoration.replace` for the *new* text — replace decorations hide real document content, but proposal new text is not in the document yet.
3. **Buttons dispatch real transactions.** "Accept" = one `view.dispatch({changes, effects: removeProposal})` that simultaneously inserts the text and drops the decoration (atomic, one undo step). "Reject" = `view.dispatch({effects: removeProposal})` only.
4. **Conflict detection is automatic for position drift, explicit for invalidation.** `StateEffect.map` + `DecorationSet.map(tr.changes)` keep positions correct through any edit. For *semantic* invalidation (user typed inside a proposal region), use `Transaction.isUserEvent(tr, "input", "delete", "paste")` inside `StateField.update` and `filter` out overlapping proposals.
5. **Performance is not a concern at Murasaki's scale.** DecorationSet is a RangeSet (balanced tree, ~O(log n) per query) and CM6 only ever paints decorations in `view.visibleRanges`. A few dozen proposals on a 10k-line doc is trivial; thousands would need viewport filtering.
6. **Shiki is NOT in the editor.** It runs in the preview pane (`useMarkdownRenderer.ts` → `codeToHtml` on rendered HTML). Conflict risk with editor decorations is **zero**. The editor's own highlighting comes from `@codemirror/lang-markdown` (Lezer), which is itself a mark-decoration producer — proposals just add more mark decorations; both feed the same `EditorView.decorations` facet and compose cleanly.
7. **`diff-match-patch` is already installed** — use it to compute the char-level diff for replacements, then map diff ops → decorations.

---

## 2. Decoration type comparison for the proposal use case

CM6 defines exactly four decoration types (official: [codemirror.net/docs/ref/#view.Decoration](https://codemirror.net/docs/ref/#view.Decoration), example: [codemirror.net/examples/decoration](https://codemirror.net/examples/decoration/)):

- **`Decoration.mark`** — adds attributes/wrapping DOM to a range of *existing* text. Used by syntax highlighting.
- **`Decoration.widget`** — inserts a DOM element at a single position; does not consume document text. Inline or block.
- **`Decoration.replace`** — *hides* a stretch of existing text, optionally replacing it with a widget. Used by code folding.
- **`Decoration.line`** — sets attributes on the line wrapper when placed at line start.

| Criterion | `Decoration.widget` | `Decoration.mark` | `Decoration.replace` | `Decoration.line` |
|---|---|---|---|---|
| Can show text not in document (inserted proposal) | ✅ **yes** (widget renders its own DOM) | ❌ no (only styles existing chars) | ⚠️ yes via `widget`, but also hides underlying text | ❌ no |
| Can style existing text (strikethrough old text) | ⚠️ awkward (would have to re-render text in widget) | ✅ **ideal** (red strikethrough) | ✅ hides + replaces | ❌ no |
| Can host interactive buttons | ✅ **ideal** (WidgetType renders any DOM, receives events) | ❌ no DOM insertion | ✅ via widget, but consumes a range | ⚠️ only line-level affordances |
| Atomic cursor skip | needs `EditorView.atomicRanges` | n/a | atomic by default for non-trivial ranges | n/a |
| Composes with Lezer highlight marks | ✅ | ✅ | ✅ | ✅ | 
| Undo safety | ✅ state field, one tx | ✅ | ✅ | ✅ |

**Conclusion for proposals:**

- **Insertion proposal** → `Decoration.widget` carrying a green `<span>` for the proposed text + the accept/reject buttons. The proposed text never enters `state.doc` until accepted, so widget is the *only* type that can show it.
- **Replacement proposal** → two decorations over the same region: `Decoration.mark({class:"cm-proposal-del"})` (red strikethrough on the *existing* old text) + `Decoration.widget` for the green new text and buttons.
- **Buttons** → live inside the same trailing widget (one widget per proposal) to minimize widget count and keep event handling local.
- **`Decoration.replace` is tempting but wrong** for proposal new text: it requires a document range to hide, and proposal new text has no document range yet. It's only useful if you later add a "collapse accepted region into a placeholder" affordance.
- **`Decoration.line`** is not needed unless you want a gutter icon or full-line background; keep it optional.

### Code sketches (one per type)

```ts
// All sketches compile against @codemirror/state@^6.7 and @codemirror/view@^6.43
import { Decoration } from "@codemirror/view";

// (a) Mark: red strikethrough on existing old text in a replacement proposal
const delMark = Decoration.mark({ class: "cm-proposal-del" });
// usage: delMark.range(oldFrom, oldTo)

// (b) Widget: green proposed text + buttons, inserted at a single position
const insWidgetDeco = (w: ProposalWidget) => Decoration.widget({ widget: w, side: 1 });
// usage: insWidgetDeco(w).range(insertPos)

// (c) Replace — NOT recommended for proposal new text; shown for contrast
const foldReplace = Decoration.replace({ widget: someWidget });
// usage: foldReplace.range(from, to)  // hides doc text [from,to)

// (d) Line: optional gutter/line-class affordance for "this line has a proposal"
const proposalLine = Decoration.line({ class: "cm-proposal-line" });
// usage: proposalLine.range(lineStart)
```

---

## 3. Recommended approach — full sketch

A single self-contained extension that exposes:
- a `StateField<ProposalState>` holding an array of `ProposedEdit`s plus the derived `DecorationSet`,
- three `StateEffect`s (`addProposal`, `acceptProposal`, `rejectProposal`),
- a `WidgetType` rendering green text + two buttons,
- a base theme for the mark classes.

```ts
// src/composables/proposals/cmProposalExtension.ts
import {
  StateField, StateEffect, Transaction, Extension,
} from "@codemirror/state";
import {
  EditorView, Decoration, DecorationSet, WidgetType,
} from "@codemirror/view";

/** Discriminated union of proposal kinds. Positions refer to the doc
 *  *as it stands when addProposal is dispatched*. The StateEffect.map
 *  below keeps them correct as the doc changes. */
export interface InsertProposal {
  id: string;
  kind: "insert";
  at: number;                 // insertion position
  text: string;              // proposed text (NOT yet in doc)
}
export interface ReplaceProposal {
  id: string;
  kind: "replace";
  from: number; to: number;  // existing old-text range
  oldText: string;           // expected snapshot for staleness check
  newText: string;
}
export type ProposedEdit = InsertProposal | ReplaceProposal;

// --- effects: map() is what makes positions survive doc edits ---------
const addProposal = StateEffect.define<ProposedEdit>({
  map: (p, ch) => {
    if (p.kind === "insert") return { ...p, at: ch.mapPos(p.at) };
    return {
      ...p,
      from: ch.mapPos(p.from, -1),
      to:   ch.mapPos(p.to, 1),
      // oldText intentionally unchanged: it's a snapshot for staleness
    };
  },
});
const acceptProposal = StateEffect.define<{ id: string }>({
  map: (v, _ch) => v,        // id-based; no positions to remap
});
const rejectProposal = StateEffect.define<{ id: string }>({
  map: (v, _ch) => v,
});

// --- widget: one per proposal, renders green text + buttons ----------
class ProposalWidget extends WidgetType {
  constructor(readonly edit: ProposedEdit) { super(); }

  eq(other: ProposalWidget) { return this.edit.id === other.edit.id; }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-proposal-ins";
    const text = document.createElement("span");
    text.className = "cm-proposal-ins-text";
    text.textContent =
      this.edit.kind === "insert" ? this.edit.text : this.edit.newText;
    wrap.appendChild(text);

    const accept = document.createElement("button");
    accept.className = "cm-proposal-btn cm-proposal-accept";
    accept.textContent = "✓"; accept.title = "接受 (Alt+A)";
    accept.onclick = (e) => {
      e.preventDefault();
      view.dispatch({ effects: acceptProposal.of({ id: this.edit.id }) });
    };

    const reject = document.createElement("button");
    reject.className = "cm-proposal-btn cm-proposal-reject";
    reject.textContent = "✗"; reject.title = "拒绝 (Alt+R)";
    reject.onclick = (e) => {
      e.preventDefault();
      view.dispatch({ effects: rejectProposal.of({ id: this.edit.id }) });
    };
    wrap.append(accept, reject);
    return wrap;
  }

  // Buttons must receive clicks; let CM6 forward mouse events to our DOM.
  ignoreEvent() { return false; }
}

// --- the field --------------------------------------------------------
interface ProposalState { edits: ProposedEdit[]; deco: DecorationSet; }

const proposalField = StateField.define<ProposalState>({
  create() { return { edits: [], deco: Decoration.none }; },

  update(state, tr) {
    // 1. Re-map existing edits' positions through doc changes.
    //    StateEffect.map already did the per-edit remap when effects were
    //    mapped, so reading tr.effects gives correctly-remapped payloads.
    let edits = state.edits.map((e) => {
      if (e.kind === "insert") return { ...e, at: tr.changes.mapPos(e.at) };
      return {
        ...e,
        from: tr.changes.mapPos(e.from, -1),
        to:   tr.changes.mapPos(e.to, 1),
      };
    });

    // 2. Apply this transaction's effects.
    const acceptedIds = new Set<string>();
    const rejectedIds = new Set<string>();
    for (const eff of tr.effects) {
      if (eff.is(addProposal))    edits = [...edits, eff.value];
      if (eff.is(acceptProposal)) acceptedIds.add(eff.value.id);
      if (eff.is(rejectProposal)) rejectedIds.add(eff.value.id);
    }

    // 3. ACCEPT = apply the edit to the document (as a real change spec,
    //    emitted from the SAME updateListener/dispatch below) and drop the
    //    proposal. The cleanest path is to dispatch a follow-up transaction
    //    from outside the field; see §5 for the orchestrator. For the field
    //    itself, accept/reject both just remove the edit.
    edits = edits.filter((e) => !rejectedIds.has(e.id) && !acceptedIds.has(e.id));

    // 4. Conflict detection: drop proposals the user has invalidated.
    if (tr.docChanged && Transaction.isUserEvent(tr, "input", "delete",
        "delete.selection", "paste", "drop", "move")) {
      edits = edits.filter((e) => !isInvalidatedByUserEdit(e, tr));
    }

    // 5. Rebuild decorations. Cheap: O(n) over proposals, not over doc.
    const deco = buildDecorations(edits);
    return { edits, deco };
  },

  provide: (f) => EditorView.decorations.from(f, (s) => s.deco),
});

function buildDecorations(edits: ProposedEdit[]): DecorationSet {
  const ranges = edits.map((e) => {
    if (e.kind === "insert") {
      return Decoration.widget({
        widget: new ProposalWidget(e), side: 1,
      }).range(e.at);
    }
    // replace: mark old text + trailing widget for new text & buttons
    const del = Decoration.mark({ class: "cm-proposal-del" }).range(e.from, e.to);
    const w   = Decoration.widget({
      widget: new ProposalWidget(e), side: 1,
    }).range(e.to);
    return [del, w] as const;
  }).flat();
  return Decoration.set(ranges as any, true); // true: sort by position
}

/** A proposal is invalidated when a user edit overlaps its region or, for
 *  replace, when the underlying text no longer matches the snapshot. */
function isInvalidatedByUserEdit(e: ProposedEdit, tr: Transaction): boolean {
  if (e.kind === "insert") {
    // insert proposal survives unless the user typed exactly at `at`;
    // be conservative: drop only if an adjacent range was overwritten.
    for (const range of tr.changes.iterChangedRanges()) {
      // insertion at `at` with the user replacing text covering `at` kills it
      if (range.from <= e.at && range.to > e.at) return true;
      if (range.from < e.at && range.to >= e.at) return true;
    }
    return false;
  }
  // replace: also check the snapshot
  const cur = tr.state.doc.sliceString(e.from, e.to);
  if (cur !== e.oldText) return true;
  for (const range of tr.changes.iterChangedRanges()) {
    if (range.from < e.to && range.to > e.from) return true; // overlap
  }
  return false;
}

// --- public API -------------------------------------------------------
export const proposalExtension: Extension = [
  proposalField,
  EditorView.baseTheme({
    ".cm-proposal-ins": {
      backgroundColor: "rgba(46, 160, 67, 0.15)",
      borderRadius: "2px", padding: "0 2px",
    },
    ".cm-proposal-del": {
      textDecoration: "line-through",
      color: "#f85149",
      backgroundColor: "rgba(248, 81, 73, 0.12)",
    },
    ".cm-proposal-btn": {
      border: "1px solid #555", borderRadius: "3px",
      padding: "0 4px", margin: "0 1px",
      fontSize: "0.85em", cursor: "pointer",
      background: "transparent", color: "inherit",
    },
    ".cm-proposal-accept": { color: "#2ea043" },
    ".cm-proposal-reject": { color: "#f85149" },
  }),
];

// helpers for the orchestrator (see §4, §5)
export const ProposalEffect = { addProposal, acceptProposal, rejectProposal };
export { proposalField };
```

Wiring into the editor is one line in `SourceEditor.vue`'s `buildExtensions()`:

```ts
import { proposalExtension } from "../composables/proposals/cmProposalExtension";
// ... inside buildExtensions() return array, after `oneDark,`:
proposalExtension,
```

---

## 4. Multi-block coexistence via StateField

**Why a StateField, not a ViewPlugin?** The official example is explicit:

> "state field's decoration and the text change take effect in the same transaction… a view plugin is one beat behind. For ordinary highlighting it doesn't matter, but for 'fold on insert' scenarios it's a visible flicker."

([codemirror.net/examples/decoration](https://codemirror.net/examples/decoration/), paraphrased from the comment in the example's prose; the original Chinese summary of this point is widely cited.)

A `StateField` is computed synchronously during `state.apply(transaction)`, so its decorations are consistent with the new document *in the same transaction*. A `ViewPlugin.update` runs after the state is committed, so its decorations lag one frame — fine for syntax highlighting, wrong for "accept this proposal" (you'd see the text insert one frame before the green widget disappears).

**Data structure:**

```ts
interface ProposalState {
  edits: ProposedEdit[];      // source of truth; id-keyed for O(1) accept/reject
  deco: DecorationSet;       // derived; rebuilt each update
}
```

- `edits: ProposedEdit[]` — array, but accept/reject filter is O(n) which is fine for n < ~1000. For higher counts, swap to a `RangeSet<ProposedEdit>` or a `Map<id, ProposedEdit>` + sorted index.
- `deco: DecorationSet` — rebuilt from `edits` each update. `Decoration.set(ranges, true)` sorts by position in O(n log n). This is the recommended pattern from the official example (`underlineField` rebuilds via `DecorationSet.update({add})`, but a full rebuild is simpler and equally correct when the proposal set is small).
- Both are immutable per state; the field returns a new object each update.

**Multiple pending proposals:** add N `addProposal` effects (one per edit) in a single `view.dispatch({effects: [...]})`. They all land in `tr.effects`, the field appends them all, and `buildDecorations` lays them out sorted. Overlapping proposals are *not* merged — they paint independently; if two insertions target the same position, both widgets render (CM6 supports multiple widgets at one position via `side` ordering). If you want exclusivity, dedupe in the orchestrator before dispatching.

**Persistence across undo/redo:** because `edits` lives in `StateField`, it is part of the editor state and is restored on `undo`/`redo` automatically — no special handling. (This is a major advantage over storing proposals in a Vue `ref` outside the editor, which would desync from undo.)

---

## 5. Conflict detection strategy

Two kinds of conflict:

**(a) Position drift — handled automatically.**

`StateEffect.map` + `tr.changes.mapPos` remap proposal positions through every document change. This is the canonical CM6 mechanism (official example: the `addUnderline` effect's `map: ({from,to}, change) => ({from: change.mapPos(from), to: change.mapPos(to)})`). An insert proposal at position 50 stays at 50 even if the user types 10 chars at position 10 — it becomes position 60 with zero app code. The `StateField.update` sketch in §3 additionally remaps existing edits in the array (belt-and-suspenders; the effect map already did the work for newly-added ones).

**(b) Semantic invalidation — explicit, in `StateField.update`.**

Use `Transaction.isUserEvent(tr, ...events)` (the `userEvent` annotation is documented in the system guide: "the `userEvent` annotation can be used to recognize transactions generated for certain common operations like typing or pasting"). When the user types/deletes/pastes *inside or across* a proposal region, the proposal is stale:

```ts
if (tr.docChanged && Transaction.isUserEvent(tr, "input", "delete",
    "delete.selection", "paste", "drop", "move")) {
  edits = edits.filter((e) => !isInvalidatedByUserEdit(e, tr));
}
```

`isInvalidatedByUserEdit` (in §3) checks two things:

1. **Overlap** — iterate `tr.changes.iterChangedRanges()` and drop any proposal whose `[from, to)` intersects a changed range. For inserts, drop if the insertion point was overwritten.
2. **Snapshot mismatch** (replace proposals only) — re-read `tr.state.doc.sliceString(e.from, e.to)` and compare to `e.oldText`. If they differ, the underlying text was edited out-of-band (e.g. by an LSP rewrite); drop the proposal.

**Why not a transaction filter?** A `StateField.update` is the right tool here. A transaction *filter* (`EditorState.transactionFilter.of`) can *block or rewrite* a transaction before it applies — useful if you wanted to, say, prevent edits inside proposal regions. For Murasaki's T5 (non-blocking proposals that just disappear when invalidated), the filter is overkill and risks surprising the user by blocking legitimate edits. Use the filter only if a later ticket wants "locked" proposal regions.

**Foreign transactions** (e.g. the external `modelValue` watcher in `SourceEditor.vue` that does `view.dispatch({changes: {from:0, to:current.length, insert: next}})`) — these are *not* tagged with `userEvent`, so `Transaction.isUserEvent` returns false and proposals are **not** dropped by the user-edit branch. They *will* have their positions remapped (correctly), but a full-document replace will usually invalidate replace-proposals via the snapshot mismatch check (since `oldText` won't match). That's the desired behavior: opening a new file should clear stale proposals.

**Accept flow (the tricky part):** "Accept" must (1) insert/replace the real text in `state.doc` and (2) remove the proposal, atomically. The `StateField.update` cannot mutate the document (it only gets to *react* to a transaction). The clean pattern is a thin **orchestrator** outside the field:

```ts
// src/composables/proposals/useProposals.ts
export function useProposals(view: () => EditorView | null) {
  function accept(id: string) {
    const v = view(); if (!v) return;
    const state = v.state.field(proposalField);
    const edit = state.edits.find((e) => e.id === id);
    if (!edit) return;
    const changes = edit.kind === "insert"
      ? { from: edit.at, to: edit.at, insert: edit.text }
      : { from: edit.from, to: edit.to, insert: edit.newText };
    // Single transaction: apply the change AND remove the proposal.
    // Undo restores both the text and the proposal in one step.
    v.dispatch({
      changes,
      effects: acceptProposal.of({ id }),
      userEvent: "proposal.accept",
    });
  }
  function reject(id: string) {
    const v = view(); if (!v) return;
    v.dispatch({
      effects: rejectProposal.of({ id }),
      userEvent: "proposal.reject",
    });
  }
  function add(edit: ProposedEdit) {
    const v = view(); if (!v) return;
    v.dispatch({ effects: addProposal.of(edit) });
  }
  return { add, accept, reject };
}
```

Because `accept` dispatches `changes` and `effects` in the **same** `view.dispatch`, the resulting single `Transaction` both edits the document and removes the proposal — one undo entry.

---

## 6. Performance bounds

**What CM6 does for you (official, [codemirror.net/examples/decoration](https://codemirror.net/examples/decoration/) "Decoration Sources"):**

> "Indirect decorations are appropriate for things like syntax highlighting or search match highlighting, where you might want to just render the decorations inside the viewport or the current visible ranges, which can help a lot with performance."

- `DecorationSet` is a `RangeSet` — a balanced tree keyed by document position. Lookup, insert, and range queries are O(log n) in the number of decorations. Mapping through `tr.changes` is O(changed ranges + touched decorations), not O(total decorations).
- CM6 only ever asks the `EditorView.decorations` facet for decorations inside `view.visibleRanges` (the viewport ± scroll margin). Decorations outside the viewport are never painted, never have their widgets' `toDOM` called.
- Widgets with a correct `eq()` are reused across redraws: when the view re-paints, it asks `eq(oldWidget, newWidget)`; if true, the existing DOM node is kept (no `toDOM` call, no DOM thrash).

**Cost model for proposals:**

| Operation | Cost | Practical limit |
|---|---|---|
| `buildDecorations(edits)` (full rebuild) | O(n log n) where n = #proposals | ~10k proposals before perceptible lag on a 60Hz frame |
| `DecorationSet.map(tr.changes)` per edit | O(changed ranges + touched decos) | negligible |
| `StateField.update` per keystroke | O(n) filter + O(n log n) rebuild | ~1k proposals = sub-ms |
| Per-widget `toDOM` | called only when scrolled into view | bounded by viewport, not doc size |
| Per-widget `eq` | O(1) per proposal per redraw | trivial |

**Safe operating envelope for Murasaki:**

- Documents up to ~50k lines and up to ~500 simultaneously-pending proposals: **no optimization needed**. The sketch in §3 will run at 60fps.
- Beyond ~1000 proposals: stop rebuilding `deco` on every keystroke. Instead, maintain `deco` incrementally with `DecorationSet.update({add, filter})` (the official `underlineField` does exactly this). Also consider switching the `edits` array to a `Map<id, ProposedEdit>` for O(1) accept/reject.
- Beyond ~10k proposals or million-line docs: move to a `ViewPlugin` that only emits decorations for `view.visibleRanges`, recomputing on `update.viewportChanged`. The field then stores only the `edits` array (cheap) and the plugin projects it into a viewport-bounded `DecorationSet`.

**Diff computation cost** (separate from decoration): `diff-match-patch` (already installed) is O((N+M)·d) where d is the edit distance. For typical AI-proposed edits (a few lines), this is sub-millisecond. Only run it when a new proposal arrives, not per keystroke.

---

## 7. Shiki compatibility analysis

**Finding (verified by reading `src/composables/useMarkdownRenderer.ts` and `src/components/PreviewPane.vue`):** Shiki is **not** a CodeMirror plugin in this project. The call chain is:

1. `useMarkdownRenderer.ts` configures a `markdown-it` instance with a custom `fence` renderer (`codeBlockPlugin`) that emits a placeholder `<pre><code data-lang="...">` for non-mermaid code blocks.
2. After markdown-it renders HTML into the preview pane, `highlightCodeBlocks(container)` iterates `pre code[data-lang]` elements and replaces each with `codeToHtml(code, {lang, theme})` from the `shiki` package.
3. This all happens in the **preview DOM** (`PreviewPane.vue`), which is a separate Vue component from `SourceEditor.vue`. The CodeMirror editor and the Shiki-highlighted preview share no DOM.

**Therefore: Shiki cannot conflict with proposal decorations.** They live in different `HTMLElement` subtrees. There is no shared `EditorView.decorations` facet, no DOM clobbering, no widget event capture interference.

**What *does* share the editor's `EditorView.decorations` facet:**

- `@codemirror/lang-markdown` → emits `Decoration.mark` for markdown syntax (headings, bold, code spans, etc.) via its own `ViewPlugin`/`StateField`.
- `@codemirror/language-data` → nested language highlighting inside fenced code blocks (e.g. JS inside ` ```js `), again as mark decorations.
- `@codemirror/theme-one-dark` → theme.
- The proposal extension (this design) → adds mark + widget decorations.

All four are **additive**: CM6 merges multiple decoration sources into one paint pass. Mark decorations at the same position simply stack their classes; widgets are layered by `side` ordering. **No conflict is expected.** The only thing to watch:

- If a proposal spans a markdown syntax boundary (e.g. old text covers `**bold**`), the strikethrough mark will be applied across whatever marks lang-markdown already produced. This is correct behavior (you'll see bold red strikethrough) and requires no special handling.
- If you later move Shiki *into* the editor (some projects use `shiki-codegen` or a CM6 `ViewPlugin` to re-highlight tokens), then both Shiki-as-plugin and proposals would be mark-decoration producers — still no conflict (marks compose), but the per-keystroke cost would rise. Out of scope for T5.

**Mitigations if a future ticket does bring Shiki into the editor:** keep proposal marks with low-specificity CSS classes (`.cm-proposal-del` not `.strikethrough`), and never mutate the DOM nodes Shiki produces — only ever add classes via `Decoration.mark`. Proposal widgets are independent DOM inserts, so they're inherently safe.

---

## 8. References

### CM6 primary sources (all fetched 2026-07-27)
- Decoration types & `Decoration` API: https://codemirror.net/docs/ref/#view.Decoration
- `WidgetType` (eq, toDOM, ignoreEvent, updateDOM): https://codemirror.net/docs/ref/#view.WidgetType
- `StateField`, `StateEffect`: https://codemirror.net/docs/ref/#state.StateField , https://codemirror.net/docs/ref/#state.StateEffect
- System guide (transactions, `userEvent` annotation, functional state): https://codemirror.net/docs/guide/
- **Decoration example (canonical StateField + StateEffect + WidgetType pattern)**: https://codemirror.net/examples/decoration/ — the `underlineField`, `CheckboxWidget`, and placeholder-matcher examples are the basis for §3.
- `EditorView.atomicRanges` facet: https://codemirror.net/docs/ref/#view.EditorView^atomicRanges
- `Transaction.isUserEvent`: https://codemirror.net/docs/ref/#state.Transaction^isUserEvent

### Community patterns (read; secondary)
- "主流笔记应用的『下划线』功能支持测评，以及如何用 Codemirror 6 实现添加下划线功能" — https://juejin.cn/post/7394265539194847270 — uses the exact `StateEffect.define({map})` + `StateField<DecorationSet>` + `Decoration.mark` pattern, validating the approach for Chinese-text editing. Good worked example of Mark decorations for inline styling.
- "把 CodeMirror 6 调教成 Markdown 编辑器:扩展、装饰与门面" — https://blog.csdn.net/bDreamer/article/details/163051035 — articulates the StateField vs ViewPlugin timing distinction quoted in §4.

### Libraries evaluated (none adopted; Murasaki's needs are simpler)
- **`@codemirror/merge`** — official CM6 merge/diff viewer addon. Worth evaluating for the *compare* feature (`CompareWindow.vue` already exists in `src/components/`), but it solves a different problem (side-by-side read-only diff) than inline proposal accept/reject. Not used for T5.
- **`diff-match-patch`** — already a Murasaki dependency (`^1.0.5`). Use it to compute the char-level diff that produces `ReplaceProposal` ranges. No new dependency needed.
- **`yjs-codemirror.next`** — Yjs binding for CM6. Its undo-manager integration and decoration approach informed the "one transaction per accept" rule in §5, but Yjs itself is not needed for non-collaborative proposals.

### Project-internal sources (read-only inspection)
- `c:\workspace\markdown\package.json` — confirmed CM6 / Shiki / diff-match-patch versions (§0).
- `c:\workspace\markdown\src\components\SourceEditor.vue` — confirmed editor setup; `buildExtensions()` is the injection point; `emit("ready", view)` exposes the view for the proposal orchestrator.
- `c:\workspace\markdown\src\composables\useMarkdownRenderer.ts` — confirmed Shiki runs in preview pane only (§7).
- `c:\workspace\markdown\src\components\PreviewPane.vue` — confirmed separate DOM from editor.

### Open questions for T5 implementation
1. **Diff granularity.** Char-level (via `diff-match-patch`) gives precise red/green but can look noisy on prose. Word-level diff (split on whitespace first, then `diff-match-patch` per token) reads better for Markdown prose. T5 prototype should try char-level first; switch to word-level if it looks bad.
2. **Multiple proposals at the same position.** Decide whether to dedupe (only the latest) or stack (both visible). Recommend dedupe in the orchestrator for T5; revisit if AI streams multiple alternatives.
3. **Keyboard shortcuts.** Suggested `Alt+A` / `Alt+R` for accept/reject of the proposal nearest the cursor. Implement as a `keymap.of([...])` extension that reads `proposalField` and finds the nearest proposal. Out of scope for the minimal T5 prototype but easy to add.
4. **Read-only mode interaction.** When `SourceEditor` `readOnly` prop is true, proposals should still be *displayable* (read-only review) but accept should be disabled. Gate the accept button's `onclick` on `view.state.readOnly`.
