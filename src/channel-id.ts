/** The channel id, in its own module so runtime/outbound don't import the
 * plugin definition (which imports them) and create a cycle. */
export const CHANNEL_ID = "azula";
