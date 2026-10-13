/**
 * Rich replies: what the phone can show of OpenClaw's portable
 * `MessagePresentation`, and how a tap on it comes back.
 *
 * OpenClaw describes a rich reply once (title, text, context, divider, charts,
 * tables, buttons, selects) and leaves each channel to render what it can. For
 * azula the split is deliberate:
 *
 *  - **Content stays text.** Titles, paragraphs, context lines, and the data
 *    blocks core flattens for us (tables and charts, because this channel does
 *    not declare them) are delivered as an ordinary chat message. That message
 *    is also the fallback: it reads correctly in history after a surface is
 *    deleted, and it is all the user has if a surface cannot be shown.
 *  - **Controls become an A2UI surface.** Buttons and selects the phone can
 *    answer are rendered as real buttons; a tap comes back as the user's reply
 *    through the existing `ui_event` -> `choice` path (see `surfaces.ts`).
 *
 * Everything here is pure: presentation in, A2UI components out. Sending,
 * tracking, and failure handling are `reply.ts`'s.
 */

import {
  adaptMessagePresentationForChannel,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
  type MessagePresentation,
  type MessagePresentationAction,
  type MessagePresentationBlock,
  type MessagePresentationButton,
  type MessagePresentationOption,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

/** The channel's declared presentation features, as the SDK types them. */
export type PresentationCapabilities = NonNullable<
  Parameters<typeof adaptMessagePresentationForChannel>[0]["capabilities"]
>;

/**
 * What this channel tells core it can render.
 *
 * Core applies these before our code sees a presentation: tables and charts
 * become text blocks (they are not declared), controls beyond the limits become
 * a plain "Actions:" list in the text, and disabled buttons are demoted to text
 * (`supportsDisabled` is off). So by the time {@link buildControlsSurface} runs,
 * everything left is something the phone can show.
 *
 * Limits are about a phone screen, not the wire (a surface may be 256 KiB):
 * twelve buttons is a long column already, and a label that does not fit one
 * line of a button is better truncated than wrapped.
 */
export const AZULA_PRESENTATION_CAPABILITIES: PresentationCapabilities = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  divider: true,
  charts: false,
  tables: false,
  limits: {
    actions: {
      maxActions: 12,
      maxLabelLength: 60,
      // A callback value comes back as the user's reply text.
      maxValueBytes: 512,
      supportsStyles: true,
      supportsDisabled: false,
    },
    selects: {
      maxOptions: 12,
      maxLabelLength: 60,
      maxValueBytes: 512,
    },
    text: { markdownDialect: "markdown" },
  },
};

/**
 * The most buttons one surface will carry.
 *
 * Core's limits already keep this to roughly twelve buttons plus twelve select
 * options (a select costs one action in core's budget however many options it
 * has), so this is only the backstop that keeps a surface a sensible size.
 * Anything past it is still in the message text.
 */
export const MAX_SURFACE_BUTTONS = 24;

/** The event name a tap on one of our buttons carries. */
const CHOOSE_EVENT = "choose";

/** Apply this channel's limits to a presentation, exactly as core would. */
export function adaptForAzula(presentation: MessagePresentation): MessagePresentation {
  return adaptMessagePresentationForChannel({
    presentation,
    capabilities: AZULA_PRESENTATION_CAPABILITIES,
  });
}

/**
 * Whether the gateway would treat some text as a command if the user sent it.
 * Injected, so this module stays free of the gateway's runtime; see
 * {@link conservativeCommandText} for the fallback and `commandTextDetector`
 * (reply.ts) for the gateway's own judgment.
 */
export type CommandTextDetector = (text: string) => boolean;

const INLINE_COMMAND_TOKEN = /(?:^|\s)[/!][a-z]/i;

/** The English abort triggers OpenClaw 2026.10.2 recognises ("stop" aborts a run). */
const ABORT_TRIGGERS = new Set([
  "stop",
  "esc",
  "abort",
  "exit",
  "interrupt",
  "halt",
  "please stop",
  "stop please",
  "stop openclaw",
  "openclaw stop",
  "stop action",
  "stop run",
  "stop agent",
]);

/**
 * A deliberately over-cautious command detector, for when the gateway's own is
 * not to hand (and for tests). It flags text that starts with `/` (a slash
 * command) or `!` (OpenClaw's host-shell shortcut), carries a command token
 * anywhere (`hey /status`, the shape the gateway's own coarse detector flags),
 * or is one of the bare words that abort a run. Wrongly flagging costs a
 * control its button (it stays in the text); wrongly passing costs a tap that
 * runs something the user never saw.
 */
export const conservativeCommandText: CommandTextDetector = (text) => {
  const trimmed = text.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("!")) return true;
  if (INLINE_COMMAND_TOKEN.test(trimmed)) return true;
  const word = trimmed
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:'"]+$/u, "")
    .trim();
  return ABORT_TRIGGERS.has(word);
};

/**
 * What a tap on a control answers with, as typed, or null when the phone has no
 * answer for it. This is only the mapping by action type; whether the answer is
 * safe to send from a button is {@link safeAnswer}'s.
 *
 * The answer is the text the agent would have received had the user typed it,
 * since that is what a button is on a text channel:
 *
 *  - `callback`: the opaque value the agent attached.
 *  - `command`: the command string, which the gateway handles as the slash
 *    command it is (the paired phone is the one sender this channel admits).
 *  - `question`: the option's label, which is what a user answering an
 *    `ask_user` question by hand would type. The "Other..." control
 *    (`intent: "custom-input"`) has nothing to send; the user just types.
 *
 * Links (`url`, `web-app`) cannot be opened from an A2UI button, so they stay in
 * the message text as `label: url`; `approval` and `model-picker` are
 * transport-private actions this channel has no way to resolve, so they stay
 * text too.
 */
function answerFor(
  action: MessagePresentationAction | undefined,
  label: string,
): { answer: string; explicit: boolean } | null {
  switch (action?.type) {
    case "command":
      return { answer: action.command, explicit: true };
    case "callback":
      return { answer: action.value, explicit: false };
    case "question":
      return "optionValue" in action ? { answer: label, explicit: false } : null;
    default:
      return null;
  }
}

/**
 * **A hidden answer never runs a command.** A tap is dispatched as the user's
 * text, and the gateway acts on any text it recognises as a command: a slash
 * command (`/reset`), the `!` host-shell shortcut (`! ls`, when
 * `commands.bash` is on), a bare abort word (`stop`), or a command token inside
 * other text. A callback's value, or a question's option, is not what the
 * button says, so a tap on "Show more" must not be able to run any of them.
 *
 * So only a `command` action may answer with a command, and for that one the
 * command is in the message text (core lists it in backticks), so the user can
 * see what the tap does. Any other answer the gateway would take for a command
 * is not minted; its control stays in the text.
 */
function safeAnswer(
  found: { answer: string; explicit: boolean } | null,
  isCommandText: CommandTextDetector,
): string | null {
  if (found === null) return null;
  return found.explicit || !isCommandText(found.answer) ? found.answer : null;
}

/** One button on the surface. */
type Control = { label: string; choice: string; primary: boolean };

function controlForButton(
  button: MessagePresentationButton,
  isCommandText: CommandTextDetector,
): Control | null {
  if (button.disabled === true) return null;
  const choice = safeAnswer(
    answerFor(resolveMessagePresentationButtonAction(button), button.label),
    isCommandText,
  );
  if (choice === null) return null;
  return {
    label: button.label,
    choice,
    primary: button.style === "primary" || button.style === "success",
  };
}

function controlForOption(
  option: MessagePresentationOption,
  isCommandText: CommandTextDetector,
): Control | null {
  const choice = safeAnswer(
    answerFor(resolveMessagePresentationOptionAction(option), option.label),
    isCommandText,
  );
  return choice === null ? null : { label: option.label, choice, primary: false };
}

/** The presentation, reduced to what the surface is made of, in order. */
type Part =
  | { kind: "text"; text: string }
  | { kind: "context"; text: string }
  | { kind: "divider" }
  | { kind: "group"; label?: string; controls: Control[] };

function partsOf(block: MessagePresentationBlock, isCommandText: CommandTextDetector): Part[] {
  switch (block.type) {
    case "text":
      return [{ kind: "text", text: block.text }];
    case "context":
      return [{ kind: "context", text: block.text }];
    case "divider":
      return [{ kind: "divider" }];
    case "buttons": {
      const controls = block.buttons.flatMap((b) => controlForButton(b, isCommandText) ?? []);
      return controls.length > 0 ? [{ kind: "group", controls }] : [];
    }
    case "select": {
      const controls = block.options.flatMap((o) => controlForOption(o, isCommandText) ?? []);
      return controls.length > 0
        ? [{ kind: "group", ...(block.placeholder ? { label: block.placeholder } : {}), controls }]
        : [];
    }
    default:
      // Tables and charts: data, so it is in the message text, not the surface.
      return [];
  }
}

/** A built surface, and the answers its buttons carry. */
export type ControlsSurface = {
  components: unknown[];
  /** What each button answers with, in surface order. Not sent; for callers that log or test. */
  choices: string[];
};

/**
 * Build the A2UI surface for a presentation's controls, or null when there is
 * nothing on it the phone can tap.
 *
 * "Controls-only" is the rule for what goes *on* the surface. It has the
 * presentation's title as its heading (the same role the question plays in
 * `buildChoiceComponents`), the buttons, and whatever the presentation put
 * *between* them (a select's placeholder, a caption, a divider), because that is
 * what makes the groups mean something. Text before the first control or after
 * the last is content, and stays in the message.
 *
 * No surface is returned for a presentation with no tappable control. A surface
 * nobody can answer would sit in the conversation until the next message
 * cleared it, and everything on it is already in the text.
 *
 * Takes the *adapted* presentation (see {@link adaptForAzula}): label and count
 * limits are core's to apply, not repeated here. `isCommandText` decides which
 * hidden answers are too dangerous to put behind a button (see {@link safeAnswer}).
 */
export function buildControlsSurface(
  presentation: MessagePresentation,
  isCommandText: CommandTextDetector = conservativeCommandText,
): ControlsSurface | null {
  const parts = presentation.blocks.flatMap((block) => partsOf(block, isCommandText));
  const first = parts.findIndex((p) => p.kind === "group");
  if (first === -1) return null;
  const last = parts.findLastIndex((p) => p.kind === "group");
  const span = parts.slice(first, last + 1);

  // A2UI components are a flat list addressed by id; containers name children.
  const components: unknown[] = [];
  const column: string[] = [];
  const choices: string[] = [];
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}-${ids++}`;

  const title = presentation.title?.trim();
  if (title) {
    const id = nextId("title");
    components.push({ id, component: "Text", text: title, variant: "h2" });
    column.push(id);
  }

  for (const part of span) {
    switch (part.kind) {
      case "text":
      case "context": {
        const id = nextId(part.kind);
        components.push({
          id,
          component: "Text",
          text: part.text,
          ...(part.kind === "context" ? { variant: "caption" } : {}),
        });
        column.push(id);
        break;
      }
      case "divider": {
        const id = nextId("divider");
        components.push({ id, component: "Divider" });
        column.push(id);
        break;
      }
      case "group": {
        const room = MAX_SURFACE_BUTTONS - choices.length;
        if (room <= 0) break;
        const group: string[] = [];
        if (part.label) {
          const id = nextId("label");
          components.push({ id, component: "Text", text: part.label });
          group.push(id);
        }
        for (const control of part.controls.slice(0, room)) {
          const text = nextId("text");
          const button = nextId("button");
          components.push({ id: text, component: "Text", text: control.label });
          components.push({
            id: button,
            component: "Button",
            child: text,
            variant: control.primary ? "primary" : "default",
            // The answer travels in the action's context, which is what the
            // tap's ui-event carries back (see `choiceFromEvent`).
            action: { event: { name: CHOOSE_EVENT, context: { choice: control.choice } } },
          });
          group.push(button);
          choices.push(control.choice);
        }
        const id = nextId("group");
        components.push({ id, component: "Column", children: group });
        column.push(id);
        break;
      }
    }
  }

  return {
    components: [
      { id: "root", component: "Card", child: "column" },
      { id: "column", component: "Column", children: column },
      ...components,
    ],
    choices,
  };
}

/**
 * Whether a presentation has a control the phone could answer, going by action
 * types alone (a callback, a command, a question option). Whether each answer
 * is safe to send is decided when the surface is built, against the gateway's
 * own judgment; this is the cheap question the outbound renderer asks to decide
 * whether to carry controls at all, and it can only be too generous, never
 * wrong: text is complete either way.
 */
export function hasAnswerableControls(presentation: MessagePresentation): boolean {
  return presentation.blocks.some((block) => {
    if (block.type === "buttons") {
      return block.buttons.some(
        (b) => b.disabled !== true && answerFor(resolveMessagePresentationButtonAction(b), b.label) !== null,
      );
    }
    if (block.type === "select") {
      return block.options.some(
        (o) => answerFor(resolveMessagePresentationOptionAction(o), o.label) !== null,
      );
    }
    return false;
  });
}

/** A location, as a line of text. */
export function formatLocation(location: NonNullable<ReplyPayload["location"]>): string {
  const place = [location.name, location.address].filter(Boolean).join(", ");
  const coordinates = `${location.latitude}, ${location.longitude}`;
  return place ? `Location: ${place} (${coordinates})` : `Location: ${coordinates}`;
}
