/**
 * CM6 Proposal Extension (Ticket #23)
 *
 * StateField + StateEffect + Decorations for agent proposals.
 * - propose_insert: green widget at position + accept/reject buttons
 * - propose_replace: red strikethrough on [from,to] + green widget with new content + accept/reject buttons
 *
 * Strict invalidation: any docChanged transaction not annotated as proposal-accept
 * expires all pending proposals.
 */
import {
  StateField,
  StateEffect,
  Transaction,
  Annotation,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

// ===== Types =====

export type ProposalType = "insert" | "replace";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "expired";

export interface Proposal {
  id: string;
  type: ProposalType;
  from: number;
  to: number;
  content: string;
  status: ProposalStatus;
  /** Line count of replacement content (for >50 line check) */
  lineCount: number;
  /** Short label for the proposal list */
  label: string;
}

// ===== Annotation to mark proposal-accept transactions =====

const proposalAcceptAnnotation = Annotation.define<boolean>();

// ===== StateEffects =====

export const addProposalEffect = StateEffect.define<Proposal>();
export const removeProposalEffect = StateEffect.define<string>();
export const expireAllProposalsEffect = StateEffect.define<null>();

// ===== WidgetTypes =====

/** Floating accept/reject buttons widget */
class ProposalButtonsWidget extends WidgetType {
  constructor(
    readonly proposalId: string,
    readonly lineCount: number
  ) {
    super();
  }

  eq(other: ProposalButtonsWidget): boolean {
    return this.proposalId === other.proposalId && this.lineCount === other.lineCount;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-proposal-buttons";
    wrapper.dataset.proposalId = this.proposalId;

    const accept = document.createElement("button");
    accept.className = "cm-proposal-btn cm-proposal-accept";
    accept.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    accept.title = this.lineCount > 50 ? `接受 ${this.lineCount} 行替换` : "接受";
    accept.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({
        effects: proposalActionEffect.of({ id: this.proposalId, action: "accept" }),
      });
    });

    const reject = document.createElement("button");
    reject.className = "cm-proposal-btn cm-proposal-reject";
    reject.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6 18 18"/></svg>';
    reject.title = "拒绝";
    reject.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({
        effects: proposalActionEffect.of({ id: this.proposalId, action: "reject" }),
      });
    });

    wrapper.appendChild(accept);
    wrapper.appendChild(reject);
    return wrapper;
  }

  ignoreEvent(event: Event): boolean {
    // Don't ignore mousedown — buttons need to handle clicks
    return event.type !== "mousedown";
  }
}

/** Insert content widget (green highlight) */
class InsertContentWidget extends WidgetType {
  constructor(
    readonly proposalId: string,
    readonly content: string
  ) {
    super();
  }

  eq(other: InsertContentWidget): boolean {
    return this.proposalId === other.proposalId && this.content === other.content;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-proposal-insert";
    wrapper.dataset.proposalId = this.proposalId;
    wrapper.textContent = this.content;
    return wrapper;
  }
}

/** Replace new content widget (green highlight, shown after strikethrough old) */
class ReplaceContentWidget extends WidgetType {
  constructor(
    readonly proposalId: string,
    readonly content: string
  ) {
    super();
  }

  eq(other: ReplaceContentWidget): boolean {
    return this.proposalId === other.proposalId && this.content === other.content;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-proposal-replace-new";
    wrapper.dataset.proposalId = this.proposalId;
    wrapper.textContent = this.content;
    return wrapper;
  }
}

// ===== Action effect (user clicks accept/reject) =====

export const proposalActionEffect = StateEffect.define<{
  id: string;
  action: "accept" | "reject";
}>();

// ===== StateField =====

/** Empty decoration set */
const emptyDeco = Decoration.none;

/**
 * Build decorations for a proposal.
 * Maps positions that may be affected by document changes to decorations.
 */
function buildDecorations(proposals: Proposal[], docLength: number): DecorationSet {
  const decos: Array<{ from: number; to: number; deco: Decoration }> = [];

  for (const p of proposals) {
    if (p.status !== "pending") continue;

    // Clamp positions to valid range
    const from = Math.max(0, Math.min(p.from, docLength));
    const to = Math.max(from, Math.min(p.to, docLength));

    if (p.type === "insert") {
      // Green insert widget at position
      decos.push({
        from,
        to: from,
        deco: Decoration.widget({
          widget: new InsertContentWidget(p.id, p.content),
          side: 1, // show after cursor
        }),
      });
      // Buttons widget right after insert content
      decos.push({
        from,
        to: from,
        deco: Decoration.widget({
          widget: new ProposalButtonsWidget(p.id, p.lineCount),
          side: 1,
        }),
      });
    } else {
      // Replace: strikethrough mark on old content
      if (to > from) {
        decos.push({
          from,
          to,
          deco: Decoration.mark({ class: "cm-proposal-replace-old" }),
        });
      }
      // Green new content widget after old range
      decos.push({
        from: to,
        to: to,
        deco: Decoration.widget({
          widget: new ReplaceContentWidget(p.id, p.content),
          side: 1,
        }),
      });
      // Buttons widget after new content
      decos.push({
        from: to,
        to: to,
        deco: Decoration.widget({
          widget: new ProposalButtonsWidget(p.id, p.lineCount),
          side: 1,
        }),
      });
    }
  }

  // Sort by position (CM6 requires sorted decorations)
  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(
    decos.map((d) => d.deco.range(d.from, d.to)),
    true
  );
}

/**
 * The proposal StateField.
 *
 * Stores proposals and produces decorations.
 * Strict invalidation: any user/doc change expires all pending proposals.
 * Proposal-accept transactions are annotated to skip invalidation.
 */
export const proposalField = StateField.define<ProposalSet>({
  create(): ProposalSet {
    return { proposals: [], decorations: emptyDeco };
  },

  update(value: ProposalSet, tr: Transaction): ProposalSet {
    let proposals = value.proposals;

    // Check for action effects first (accept/reject from button clicks)
    for (const effect of tr.effects) {
      if (effect.is(proposalActionEffect)) {
        const { id, action } = effect.value;
        if (action === "accept") {
          // Mark as accepted — the actual text change is applied separately
          proposals = proposals.map((p) =>
            p.id === id ? { ...p, status: "accepted" as ProposalStatus } : p
          );
        } else if (action === "reject") {
          proposals = proposals.map((p) =>
            p.id === id ? { ...p, status: "rejected" as ProposalStatus } : p
          );
        }
      } else if (effect.is(addProposalEffect)) {
        proposals = [...proposals, effect.value];
      } else if (effect.is(removeProposalEffect)) {
        proposals = proposals.filter((p) => p.id !== effect.value);
      } else if (effect.is(expireAllProposalsEffect)) {
        proposals = proposals.map((p) =>
          p.status === "pending"
            ? { ...p, status: "expired" as ProposalStatus }
            : p
        );
      }
    }

    // Strict invalidation: if doc changed and it's NOT a proposal-accept, expire all
    if (tr.docChanged && !tr.annotation(proposalAcceptAnnotation)) {
      proposals = proposals.map((p) =>
        p.status === "pending"
          ? { ...p, status: "expired" as ProposalStatus }
          : p
      );
    }

    // Rebuild decorations only if proposals changed
    if (proposals === value.proposals) {
      return value;
    }

    return {
      proposals,
      decorations: buildDecorations(proposals, tr.newDoc.length),
    };
  },

  provide: (field) => EditorView.decorations.from(field, (s) => s.decorations),
});

// ===== ProposalSet type =====

export interface ProposalSet {
  proposals: Proposal[];
  decorations: DecorationSet;
}

// ===== Helper: apply proposal acceptance as a document change =====

/**
 * Apply a proposal acceptance as a document transaction.
 * Uses addToHistory.of(true) so the user can undo (Ctrl+Z).
 * Annotated with proposalAcceptAnnotation so the StateField doesn't expire others.
 */
export function applyProposalAcceptance(
  view: EditorView,
  proposal: Proposal
): void {
  if (proposal.type === "insert") {
    view.dispatch({
      changes: { from: proposal.from, to: proposal.from, insert: proposal.content },
      annotations: [proposalAcceptAnnotation.of(true), Transaction.addToHistory.of(true)],
      effects: removeProposalEffect.of(proposal.id),
    });
  } else {
    view.dispatch({
      changes: { from: proposal.from, to: proposal.to, insert: proposal.content },
      annotations: [proposalAcceptAnnotation.of(true), Transaction.addToHistory.of(true)],
      effects: removeProposalEffect.of(proposal.id),
    });
  }
}

/**
 * Apply a proposal rejection.
 * Just removes the proposal from the field.
 */
export function applyProposalRejection(
  view: EditorView,
  proposalId: string
): void {
  view.dispatch({
    effects: removeProposalEffect.of(proposalId),
  });
}

/**
 * Get all proposals from the editor state.
 */
export function getProposals(state: { field: <T>(f: StateField<T>) => T }): Proposal[] {
  return state.field(proposalField).proposals;
}

/**
 * Get pending proposals count.
 */
export function getPendingCount(state: { field: <T>(f: StateField<T>) => T }): number {
  return state.field(proposalField).proposals.filter((p) => p.status === "pending").length;
}
