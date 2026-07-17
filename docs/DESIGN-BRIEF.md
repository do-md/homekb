# HomeKB Design Brief

> A product briefing for design (Claude Design / the designer). Purpose: to make clear **what HomeKB is, who it's for, what features it has, what information each feature needs to surface, and which states need to be distinguished** — leaving "how to design it" entirely up to you. This document does **not** prescribe layout, color, or component placement; wherever visual expression is involved, it only states "what needs to be conveyed," never "what it should look like."

>
> Protocol/interface details are authoritative in `docs/ARCHITECTURE.md`; this document only pulls out the parts design needs to know.

---

## 1. What This Is

**HomeKB is a personal knowledge base where "your data always stays on your own computer."**

Users keep their Markdown notes in a folder on their own computer, and a local engine automatically compiles them into a semantic index. From then on, users can use semantic search and AI Q&A to find, read, and edit these notes from **any device** — a phone browser, the Claude mobile app, or Claude Code. But the knowledge content **never leaves the user's computer**: the server in the middle only relays traffic and stores no notes.

The three trust signals the product must reinforce over and over are the core of its overall character:

1. **Data sovereignty** — data always stays on your own computer; the server stores no content.
2. **Account-free** — no sign-up or login; a one-time pairing code binds a device to your home computer.
3. **Agent-native** — designed for AI assistants from the ground up; Claude can read and write this knowledge base directly.

Character keywords: **trustworthy, private, restrained, focused.** This is not a social product, not a cloud notes app — it's more like "a quiet second brain living on your own computer."

---

## 2. Who Uses It, and on What Devices

Two kinds of users, two kinds of shells, but they **share the same interface**:

- **General users** — install a desktop app on their home computer (as the "data host"), and access it remotely from a phone or other devices via the web. **This is the design focus.**
- **Technical users** — use only the command-line tool and never touch the interface (out of scope for design, but it defines the product's full capability set).

One mental model you must understand: **"home" vs. "remote."**

- **Home computer**: where the data and index live; it must be running (with a background process active) to be accessed.
- **Remote devices**: phones and the like, connected to the home computer via a pairing code.
- Therefore **"is home online right now?" is first-class information throughout** — on any remote interface, the user should be able to sense at a glance "can I reach home right now?" This is the unique state that sets this product apart from ordinary cloud apps, and it's worth designing a dedicated visual language to express (online / offline / connecting).

---

## 3. What the Product Can Do (Full Capability Set)

This is what the design truly needs to revolve around. The things users can do:

| Feature                          | User intent                                                | Information surfaced                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Semantic search**              | "Have I ever noted anything related to this?"              | A set of hits ranked by relevance: title, parent document, snippet body, type label, relevance, time                                       |
| **AI Q&A**                       | "Just tell me the answer"                                  | A single answer synthesized by the AI + which notes it cited (openable to the original text)                                               |
| **Reading notes**                | View the full text of a note                               | Markdown body (currently plain text; ideally rich-text rendering) + document identifier                                                    |
| **Editing notes**                | Edit a note in place and save it back to the home computer | Editor + save/cancel + save-result feedback                                                                                                |
| **Creating notes**               | Jot down a note and file it                                | Title (optional) + body editing + file-in result feedback                                                                                  |
| **Library health**               | "What state is my library in right now?"                   | A set of stats (document count, indexing progress, pending items, last compile time, etc.) + connection state + manually trigger a compile |
| **Pairing a new device**         | Let a new device access home                               | Enter a one-time pairing code; or generate a pairing code on the home side to hand out                                                     |
| **Configuration (desktop only)** | Manage the engine, keys, and remote access                 | Engine info, data directory, OpenAI Key, relay registration, tunnel toggle, generate pairing code                                          |
| **Connector authorization**      | Let the Claude mobile app connect                          | A page where "entering a pairing code grants authorization"                                                                                |

**Search and Q&A are two modes under the same entry point** — the user types a sentence and can ask for either "a bunch of relevant snippets" or "one synthesized answer." How these two modes switch and how each is presented is the design point most worth polishing on the core page.

---

## 4. Surfaces to Design

By importance:

1. **Main application (mobile-first responsive interface)** — carries most of the features in §3. Remote devices and the desktop app both use the same one. This is the main battleground.
2. **Pairing / landing page** — the "enter a pairing code" entry point when a remote device first opens, and also the face of the product, where the privacy narrative appears for the first time.
3. **Desktop config page** — desktop-app only; manages the engine / keys / remote access / pairing codes.
4. **Desktop first-run onboarding** — when the desktop app opens for the first time, it's detecting / installing the engine / starting the service in the background, so a "getting things ready" transitional screen is needed (including failure retry).
5. **AI connector authorization page** — a standalone single page users are redirected to when connecting from within Claude, where they enter a pairing code to complete authorization.

> The main application is the same interface across both shells (desktop app / mobile web); only the "config page" is desktop-exclusive. Design it once, and it takes effect in both places.

---

## 5. Information Each Feature Surfaces (Content Model)

When designing layouts, these are the data fields that actually exist, to help you judge the information hierarchy — what to emphasize and what to omit:

- **Search hit**: title, parent document path, heading hierarchy within the document (e.g. "Chapter › Section"), snippet body, relevance score, document type (the label the engine auto-classifies, such as note / tutorial / reference), modified time.
  - Hits come at three granularities: a single snippet, a document summary, or a whole document — you may consider whether these should be expressed distinctly.
- **AI answer**: a passage of answer text + a set of citations (each citation points to a specific note, openable).
- **Document list item** (e.g. "Recently updated"): title, type, modified time, size.
- **Library status**: total documents, chunk count, vectorization progress, pending-compile count, failure count, index version, last compile time, and the name of the embedding model used.
- **Document type (docType)**: a valuable dimension that is currently only lightly used — the engine auto-classifies every note. At present only label display is implemented; filtering/browsing by type is **not** built. This is a clear design opportunity (see §7).

---

## 6. States That Need to Be Distinguished (about "what to convey," not "what color to use")

Because of the "remote + home may be offline" nature, states matter more here than in a typical app. Each of the following state classes needs to be conveyed clearly and immediately — **express them with color, shape, motion, copy, or whatever means you deem fit; exactly how is up to you**:

- **Connection state**: reachable home / home offline / probing. This is the most distinctive and most recognizable group; we recommend a consistent visual language running throughout (for example, a persistent status indicator). When offline, it shouldn't just "change color" — ideally it also guides the user on "how to wake home up."
- **Loading**: search, Q&A, reading a document, and pulling status can all involve waiting (remote adds network latency on top). Let users know "it's spinning, not frozen."
- **Success feedback**: saved, filed, compile triggered — confirm it lightly and non-blockingly.
- **Errors**: search failure, read/write failure, invalid pairing code, etc. — clearly state what happened and whether it can be retried.
- **Empty states**: before any search, when a search returns no results, and when the library has no notes yet. In particular, **"a brand-new user with a completely empty library" currently has no dedicated design** — an important opportunity (see §7).

The one-line principle: **at any moment, the user should be able to tell "is this good or bad right now, do I need to wait, and what's my next step."** As for which colors and icons express that, you understand it better than this document does.

---

## 7. Known Gaps and Design Opportunities (proactive proposals welcome)

These are the places currently not built or only lightly built — the ones most worth the designer's creativity:

1. **Markdown rich-text rendering** — the reading page is currently bare text, lacking real typography (headings, lists, code blocks, blockquotes, links).
2. **Image / attachment presentation** — the data structure already reserves images and attachments, but there's no display scheme yet; how to view a note containing images is a blank.
3. **Pairing QR code** — the pairing code is currently plain text, which the phone has to type by hand. Scanning a QR code to pair would cut the effort dramatically.
4. **Browse / filter by type** — the docType data already exists, but there's no filter or category-navigation entry point.
5. **A brand-new user's first experience** — onboarding for an empty knowledge base (how to jot down the first note, how to get the phone connected) is currently missing.
6. **Feel and guidance when offline** — when home is offline, beyond a status indicator, can we give the user a clear next step?
7. **Confirmation for dangerous actions** — such as "unpair," which needs a graceful confirmation interaction.
8. **The overall first-setup journey** — from installing the app to "the phone can search notes," there are steps in between such as configuring keys and pairing, worth designing as one complete guided journey (rather than buttons scattered here and there).

---

## 8. Key User Journeys (to give you the big picture)

- **First setup (home computer)**: open the desktop app → the engine is auto-prepared in the background → enter the main interface → configure the OpenAI Key → the engine starts compiling notes → watch the index gradually build up on the status page.
- **Making the phone able to access**: on the desktop, enable remote access and generate a pairing code → the phone opens the web page and enters the pairing code → enter the main interface and search notes from home.
- **Daily use (phone)**: open → ask a question / do a search → view the answer or hits → tap into the original text to read → edit and save in place when needed.
- **Connecting Claude**: add the HomeKB connector in Claude → jump to the authorization page and enter a pairing code → afterward Claude can search / read / write this knowledge base directly.

---

## 9. Design Constraints (the truly fixed part)

These are boundaries already set on the engineering side and not recommended to change; everything else is free:

- **Mobile-first**, and the same interface must also work well in a desktop browser / desktop app. Mind the phone's safe areas (notch, bottom bar).
- **Light/dark theme follows the system** — there are only light and dark sets, decided by the operating system, with **no** manual toggle inside the app. So every interface must provide both **light and dark** visuals, and both must look good with adequate contrast.
- **English-first** copy, in a restrained and trustworthy tone; technical identifiers (command names, paths, etc.) stay in their original English form.
- **No native system dialogs inside the desktop app** — all confirmations/prompts are done with in-app interface elements.
- **The technical base is DaisyUI + Tailwind** — this is the component library used for implementation, not a constraint on your design. Design for the best experience; engineering will map your design to implementation and extend it where necessary. **Don't avoid an effect just because "DaisyUI doesn't have it by default."**

---

## 10. One-Page Overview (TL;DR)

- **Product**: a local-first personal knowledge base; data never leaves the user's computer; account-free; built for AI assistants.
- **Core features**: semantic search / AI Q&A (two modes under one entry point), reading, editing, creating, library health, pairing devices, and (desktop) configuration.
- **To design**: the mobile-first main application + the pairing landing page + the desktop config page + the desktop first-run onboarding + the AI connector authorization page.
- **What's unique**: "is home online?" is a first-class state, worth a dedicated visual language.
- **Most worth polishing**: the search/Q&A core page.
- **Biggest gaps**: Markdown rich rendering, image presentation, pairing QR code, empty-state / new-user onboarding, browse-by-type.
- **Hard constraints**: mobile-first, follow system light/dark (build both light and dark, no toggle), English, no native system dialogs on desktop. Everything else is open to your creativity.