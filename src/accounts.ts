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
  device: string;
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

/** Every configured account id, root first. */
export function listAccountIds(cfg: RawChannelConfig | undefined): string[] {
  if (!cfg) return [];
  const ids = [DEFAULT_ACCOUNT_ID];
  for (const id of Object.keys(cfg.accounts ?? {})) {
    if (id !== DEFAULT_ACCOUNT_ID) ids.push(id);
  }
  return ids;
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
      "the azula channel is not configured; add `channels.azula.device`",
    );
  }

  const sub = id === DEFAULT_ACCOUNT_ID ? undefined : cfg.accounts?.[id];
  if (id !== DEFAULT_ACCOUNT_ID && !sub) {
    throw new AzulaAccountError(`no azula account named '${id}'`);
  }

  const device = str(sub?.device) ?? str(cfg.device);
  if (!device) {
    throw new AzulaAccountError(
      `azula account '${id}' has no \`device\`; name the paired device it should talk to`,
    );
  }

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
