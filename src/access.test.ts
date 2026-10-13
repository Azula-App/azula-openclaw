import { describe, expect, it } from "vitest";
import { inviteUrl, pairingMessage } from "./access.js";

/** What `start_pairing` returns from azula 0.3.0: the URL, a fenced QR, a footer. */
const INVITE = [
  "https://azula.app/i/aziaeaxgbo2x4lh36icnlgxpe3kz3ergaevaagsmtio654gcj3jstzcf",
  "",
  "```",
  "                  ",
  "    █▀▀▀▀▀█  ▄█▄  ",
  "    █ ███ █ █▀█▀  ",
  "    ▀▀▀▀▀▀▀ █▄▀▄  ",
  "                  ",
  "```",
  "",
  "Scan with your phone's camera or open the URL to pair this device.",
].join("\n");

describe("the pairing message", () => {
  const message = pairingMessage(INVITE, { accountId: "default", session: "openclaw" });

  it("carries azula's own invite: its URL, and its QR untouched", () => {
    expect(message).toContain("https://azula.app/i/aziaeaxgbo2x4lh36icnlgxpe3kz3ergaevaagsmtio654gcj3jstzcf");
    expect(message).toContain("    █▀▀▀▀▀█  ▄█▄  \n    █ ███ █ █▀█▀  \n    ▀▀▀▀▀▀▀ █▄▀▄  ");
  });

  it("drops the markdown fence and azula's footer, which a terminal would print as noise", () => {
    expect(message).not.toContain("```");
    expect(message).not.toContain("Scan with your phone's camera");
  });

  it("says which account and session the phone pairs with, and what to tap", () => {
    expect(message.split("\n")[0]).toBe("Pair a phone with azula (account 'default', session 'openclaw').");
    expect(message).toContain('tap "+ connect a peer"');
  });

  it("offers a phone the session already has, with the line that uses it", () => {
    const withKnown = pairingMessage(INVITE, { accountId: "work", session: "openclaw-work", alreadyPaired: ["a", "b"] });
    expect(withKnown).toContain("A phone is already connected to this session: a, b.");
    expect(withKnown).toContain("openclaw config set channels.azula.accounts.work.device a");
    expect(message).not.toContain("already connected");
  });

  it("shows an invite in a shape it does not know whole, rather than guessing", () => {
    const odd = pairingMessage("open https://azula.app/i/zzz to pair", { accountId: "default", session: "openclaw" });
    expect(odd).toContain("open https://azula.app/i/zzz to pair");
  });

  it("still works with no context", () => {
    expect(pairingMessage(INVITE)).toContain("Pair a phone with azula.");
  });
});

describe("inviteUrl", () => {
  it("pulls the URL out of the invite", () => {
    expect(inviteUrl(INVITE)).toMatch(/^https:\/\/azula\.app\/i\/azia/);
    expect(inviteUrl("nothing here")).toBeNull();
  });
});
