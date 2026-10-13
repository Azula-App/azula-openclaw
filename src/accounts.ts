/**
 * Account resolution for the `azula` channel.
 *
 * OpenClaw's convention is a root account plus named sub-accounts under
 * `accounts.<id>`, where an omitted field inherits from the root. Kept here as
 * plain functions over plain data so it can be unit-tested without a gateway.
 */

export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_SESSION = "openclaw";
export const DEFAULT_LABEL = "OpenClaw";
export const DEFAULT_BINARY = "azula";

/** One account's settings, after inheritance is applied. */
export type ResolvedAzulaAccount = {
  accountId: string;
  enabled: boolean;
  /**
   * The paired device this account serves. Unset until a phone has been paired:
   * an account with no device starts in its pairing state and adopts the first
   * phone that pairs with its session.
   */
  device: string | undefined;
  binary: string;
  session: string;
  label: string;
};

type RawAccount = {
  enabled?: unknown;
  device?: unknown;
  binary?: unknown;
  session?: unknown;
  label?: unknown;
};

type RawChannelConfig = RawAccount & {
  accounts?: Record<string, RawAccount> | undefined;
};

export class AzulaAccountError extends Error {}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Pull `channels.azula` out of a gateway config without assuming its shape. */
export function azulaSection(cfg: unknown): RawChannelConfig | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels;
  const own = channels?.["azula"];
  return typeof own === "object" && own !== null ? (own as RawChannelConfig) : undefined;
}

/** The `--account` flag an operator needs for this account, or nothing for the default. */
function accountFlag(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? "" : ` --account ${accountId}`;
}

/** The command that starts pairing for an account (the channel's login affordance). */
export function loginCommand(accountId: string): string {
  return `openclaw channels login --channel azula${accountFlag(accountId)}`;
}

/** The config path that names an account's device. */
export function deviceConfigPath(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID
    ? "channels.azula.device"
    : `channels.azula.accounts.${accountId}.device`;
}

/** The exact command that points an account at a device by hand. */
export function configSetCommand(accountId: string, device: string): string {
  const arg = /^[\w.:@/+-]+$/.test(device) ? device : `'${device.replaceAll("'", `'\\''`)}'`;
  return `openclaw config set ${deviceConfigPath(accountId)} ${arg}`;
}

/**
 * Every configured account id, root first.
 *
 * The root account is listed when it names a device of its own, or when there
 * are no named accounts at all (the single-account setup, where an empty
 * `channels.azula` is how an operator asks for a phone to be paired). With
 * named accounts and a device-less root, the root is only the shared defaults
 * they inherit from, and starting it would open a second, unwanted pairing
 * session.
 */
export function listAccountIds(cfg: RawChannelConfig | undefined): string[] {
  if (!cfg) return [];
  const named = Object.keys(cfg.accounts ?? {}).filter((id) => id !== DEFAULT_ACCOUNT_ID);
  const root = str(cfg.device) !== undefined || named.length === 0;
  return root ? [DEFAULT_ACCOUNT_ID, ...named] : named;
}

/**
 * Resolve one account, inheriting unset fields from the root.
 *
 * The session name defaults per-account rather than globally: two accounts
 * sharing one persistent session would bind the same key, and azula gives each
 * process its own session identity precisely so they cannot collide. Deriving
 * it from the account id keeps that guarantee without the operator having to
 * think about it.
 */
export function resolveAccount(
  cfg: RawChannelConfig | undefined,
  // `null` as well as `undefined`: the SDK's ChannelConfigAdapter passes
  // either for "the root account".
  accountId?: string | null,
): ResolvedAzulaAccount {
  const id = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  if (!cfg) {
    throw new AzulaAccountError(
      "the azula channel is not configured; run `openclaw config set channels.azula.enabled true`, then `openclaw channels login --channel azula` to pair a phone",
    );
  }

  const sub = id === DEFAULT_ACCOUNT_ID ? undefined : cfg.accounts?.[id];
  if (id !== DEFAULT_ACCOUNT_ID && !sub) {
    throw new AzulaAccountError(`no azula account named '${id}'`);
  }

  // No device is a state, not an error: the account starts in its pairing
  // state and adopts the first phone that pairs with its session.
  const device = str(sub?.device) ?? str(cfg.device);

  const enabled =
    typeof sub?.enabled === "boolean"
      ? sub.enabled
      : typeof cfg.enabled === "boolean"
        ? cfg.enabled
        : true;

  const session =
    str(sub?.session) ??
    (id === DEFAULT_ACCOUNT_ID
      ? (str(cfg.session) ?? DEFAULT_SESSION)
      : // A sub-account inheriting the root's session name would collide with
        // it, so derive a distinct one instead of inheriting.
        `${str(cfg.session) ?? DEFAULT_SESSION}-${id}`);

  return {
    accountId: id,
    enabled,
    device,
    binary: str(sub?.binary) ?? str(cfg.binary) ?? DEFAULT_BINARY,
    session,
    label: str(sub?.label) ?? str(cfg.label) ?? DEFAULT_LABEL,
  };
}

/** Resolve every configured account, skipping those that fail to resolve. */
export function resolveAllAccounts(cfg: RawChannelConfig | undefined): {
  accounts: ResolvedAzulaAccount[];
  errors: Array<{ accountId: string; error: Error }>;
} {
  const accounts: ResolvedAzulaAccount[] = [];
  const errors: Array<{ accountId: string; error: Error }> = [];
  for (const id of listAccountIds(cfg)) {
    try {
      accounts.push(resolveAccount(cfg, id));
    } catch (error) {
      // One misconfigured account must not stop the others from starting.
      errors.push({ accountId: id, error: error as Error });
    }
  }
  return { accounts, errors };
}
