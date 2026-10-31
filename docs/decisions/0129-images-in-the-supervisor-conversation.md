# ADR-0129 — Images in the Supervisor conversation: the user's input, never consent, never a ground

- **Status:** Accepted (2026-10-31)
- **Amends:** [ADR-0128](./0128-the-user-talks-to-the-supervisor.md) §2 (what the user's words are) and §7 (guardrails)
- **Related:** [ADR-0127](./0127-a-supervisor-session-oversees-the-tabs.md) §5–§6

## Context

The Supervisor tab (ADR-0128, milestone 7) shipped with a text-only composer. The user tried it and could not paste a screenshot: "I can't copy paste images to the supervisor chat." The main chat sends a pasted image as an `@/abs/path.png` token, and the agent reads it with `Read`. The supervisor cannot use that path. Its `Read` refuses everything outside the project and its own data directory (`supervisor-dispatch.ts`, `readRefusal`), and its wake sent the model a plain string.

## Decision

**An image the user attaches in the Supervisor tab reaches the supervisor model as image content. Like text, it is the user's input and never consent. Unlike text, it is never a ground.**

1. **Route.** `POST /api/supervisor/message` accepts `images: [{mediaType, data}]`:
   - at most 4 images per message;
   - PNG or JPEG only, and the decoded bytes must match the declared type;
   - each image at most 3.75 MB decoded;
   - the body is measured in bytes.

   Text may be empty when at least one image is present. The ledger line counts the images and their size.
2. **Storage.**
   - **Where:** `supervisorDir(projectId)/attachments/<uuid>.<png|jpg>`, file mode 0600 and directory mode 0700, under the data dir and never in the repository.
   - **Ids:** minted by the server, never taken from the request body.
   - **Write order:** every file is written before the message line; on any failure the files written so far are deleted.
   - **What the record holds:** `{id, mediaType, bytes}` and no path. `listMessages` drops any record whose id is not a UUID or whose type is off the list.
3. **The single-machine assumption.** `GET` adds an absolute `path` to each attachment, so the app can draw it in the bubble and open it in Quick Look. This is sound because the app and the sidecar run as the same user on the same machine, and the capability token already grants the whole conversation. A remote client would need a bytes route instead.
4. **Retention.**
   - Attachment files survive while one of the last 100 messages names them; 100 is the window `GET` shows. Each new user message prunes the rest, orphans included.
   - In the app, a pasted image is saved to `~/.marvin/attachments` for its chip, and that copy is deleted once the route returns 200.
5. **The wake.**
   - A message wake that carries images sends one streaming user message: the packet text, then the images as base64 image blocks. It uses `turn-input.ts`'s channel, which the result closes.
   - Only the wake's own messages' images are attached. A rotated session's conversation history stays text.
   - A wake attaches at most 8 images. The packet names any it left out, so none is dropped silently.
   - **Image continuity lasts one SDK session.** Images cost about 1.5–3K tokens each and push a session toward rotation sooner.
6. **Never consent, never a ground.**
   - ADR-0128 §2.3 is unchanged: no input, in any form, resolves a confirm, a question or an act.
   - A `message:` ground must quote the message's **text** verbatim (`resolveGround`). An image-only message therefore cannot ground an act or a `new_session` request, and neither can the supervisor's description of what an image shows.
   - The packet tells the supervisor so, and tells it to ask the user for words.
7. **Secrets.** A screenshot of a terminal is the common way a key leaks, and the text scan alone does not see one. The app runs on-device text recognition (Vision) on each image before it sends. The route then runs `containsSecretShape` on that recognised text and refuses the message if it matches; the text is never stored or forwarded. **What this does not cover:** the check is the app's. A client holding the token could skip it, and recognition misses some text. It reduces the risk and does not remove it.

## Consequences

- The tab's composer reuses the main chat's paste, drop and chip components. Non-image files travel as backticked project-relative paths, never as `@path` tokens, so whatever the CLI does with an `@` mention cannot bypass the supervisor's read check.
- Replies render as Markdown with every link removed (`MarkdownView(inert:)`), as ADR-0128 §3 already required.

## Scope of Done

- [x] The route validates, stores and returns images; tests cover a type/bytes mismatch, too many images, a body measured in bytes, the secret refusal and the file mode.
- [x] The wake sends the wake's own images as image blocks and names any over the cap.
- [x] An image-only message, and an image saying "approve", resolve nothing (tests in `supervisor-m7-cards.test.ts`).
- [x] Attachments are pruned to the last 100 messages.
