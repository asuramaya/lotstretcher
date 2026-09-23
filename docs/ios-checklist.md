# iOS and Safari checklist

Nothing in this repository has been run on an iPhone, iPad or any Safari.
Every measurement in `web/README.md` is desktop Chromium. This is the
list to run on a real device; each line names what to look for and what
to report back. Ten minutes end to end.

Open **https://lotstretcher.org/app.html** (or the dev instance) in
Safari. For each step, note pass, fail, or the message shown.

## 1. Load

- The app opens to the Photos pane with no error banner.
- Tap **About**. Report the runtime line: threads and whether it says
  "cross-origin isolated". Safari 17+ should show threads; older shows
  single-threaded.
- On the same About line, report the **core** entry. It should read
  "core: wasm v7" (or higher). That is the Rust core, built with SIMD,
  which Safari has had since 16.4; if it says the core failed to load,
  copy the message exactly, since nothing composes without it.
- Report iOS version and device model (Settings > General > About).

## 2. Add photos

- **Choose photos**: the photo picker opens and the chosen images appear
  as tiles. HEIC photos are the case to watch: report whether they show
  a thumbnail or a blank tile.
- **Take photo**: the camera opens (the button only shows on a phone).
- Add five to eight exterior photos of one vehicle, and one or two of
  its interior.

## 3. Process

- Tap **Process**. Report the time from tap to the first cutout
  appearing, and to "done".
- Report whether Safari reloaded the page during the run (a white flash
  and the photos gone). That is the memory ceiling, and it is the single
  most important result of this test.
- Report any banner text on the Results pane.

## 4. Results

- Hero stills render, and the compare slider moves under a finger.
- An **Interiors** section shows the cabin photos, brighter than the
  originals and otherwise unchanged (no crop, no backdrop).
- **Download**: report whether the bundle zip lands in Files, and its
  size. Open it: there should be an `interior/` folder next to the hero
  images when interiors were added.
- If video was on: report whether a clip rendered, or the message that
  says video is unavailable. WebCodecs on iOS is the open question.

## 5. Details and listing

- Import a window sticker PDF from Files. Report whether fields fill.
- Open **From a listing** and tap **Copy the bookmarklet**. Add a
  bookmark in Safari, edit its address to the copied text, then open a
  vehicle page on a dealer site and tap the bookmark. Report whether the
  app opens filled in.

## 6. Library

- Tap **Library**, then **Open a listings folder**. On iOS this uses the
  plain folder picker. Report whether a folder from Files opens and
  whether hero tiles appear.

## Report

Paste the notes back as a message. Anything that failed, include the
exact text on screen. Screenshots help most for step 3.
