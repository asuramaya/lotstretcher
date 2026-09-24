# iOS and Safari checklist

Nothing in this repository has been run on an iPhone, iPad or any Safari.
Every measurement in `web/README.md` is desktop Chromium. This is the
list to run on a real device; each line names what to look for and what
to report back. Ten minutes end to end.

Open **https://lotstretcher.org/app.html** (or the dev instance) in
Safari. For each step, note pass, fail, or the message shown.

## 1. Load

- The app opens to the Photos pane with no error banner.
- Tap the gear in the header (Settings), under **This host**. Report the runtime line:
  threads and whether it says "cross-origin isolated". Safari 17+ should
  show threads; older shows single-threaded.
- On the same runtime line, report the **core** entry. It should read
  "core: wasm v8 on the page; a run uses the threaded core in a worker"
  (or higher). That is the Rust core, built with SIMD, which Safari has
  had since 16.4; if it says the core failed to load, copy the message
  exactly, since nothing composes without it. If it says "single-threaded
  (not isolated)" or "no worker here", report that too: a run still
  works, on one thread.
- Report iOS version and device model (Settings > General > About).

- After a run (section 4), the Results pane's "Rendering video" line
  should end "on N threads" when the Settings line promised the threaded
  core. Report N. If it is missing, the worker fell back to the page;
  open Safari's console (Settings > Safari > Advanced > Web Inspector)
  and copy any line starting "core worker" or "video worker".

## 2. The booth: photos and the vehicle

- **Add photos**: the photo picker opens and the chosen images appear
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

## 5. The vehicle fields and a listing

- Import a window sticker PDF from Files. Report whether fields fill
  and the sticker row turns green.
- Tap **Scan VIN** on the Vehicle section and point the camera at a
  door-jamb VIN barcode. Report whether the VIN, year and make fill in;
  if the camera is refused, try **A photo of the barcode instead**.
- Tap a photo in the strip: it opens full size; swipe for the next.
- With photos and a make in, pull to refresh (or close and reopen the
  tab). A banner should offer the car back: tap **Resume** and report
  whether the photos and fields return, and whether the Studio opens
  at once (a finished sort and cut comes back with the car; the header
  should not sort again); try **Discard** once too.
- In the Studio the tools are a bar above the nav. Tap **Backdrop**: a
  card should slide up over the lower half of the stage, the frame and
  the shape chips still in view above it. Tap **Backdrop** again, or
  its ×: the card goes and the stage takes the screen. Report whether
  the card scrolls on its own without the page moving behind it.
- In the Backdrop card, switch **Gradient** and **Image**: the card
  must stay open. On Gradient tap **Two-tone**, then the Colour A and
  Colour B dots: iOS's picker should open and the stage follow; **Paint**
  goes back. Tap **Bands** and move **Angle**; **Auto** clears it.
- Frame card: **Drawn**, tap **Line**; move Weight, Inset and Corners
  and tap the colour dots (White, Black, Paint, and the picker dot).
- In the Studio, tap the **Portrait** chip under the stage: the stage
  should turn tall, the whole portrait in view, nothing clipped. Tick
  its circle and report whether it joins the run (the Output tool's
  count). Switch the segment to **Video** and tap **Portrait**: a frame
  of the clip should show, with a scrub slider under the chips. Turn
  the phone sideways and report whether the stage refits.
- Backdrop tool: tap **Your image** and pick a photo from the camera
  roll. It should appear as its own tile, chosen, and stay after a
  reload; tap its corner × to drop it.
- Text tool: set **Title** to the vehicle, then drag the words on the
  stage with a finger to another corner. They should follow as you
  drag and the Text tool's Position should read the corner you let go
  in; the stage must not scroll while dragging. Then type a **Line**,
  open the **Line** tab and drag again: only the line should move, and
  its Position grid should light the corner while the title stays put.
  Under Font, pick **Anton**: the words should redraw in it within a
  second or two (the font is fetched on first use, ~170 KB).
- Frame tool: tap **Studio line**, then the **Your own** tile under
  Line colour. Report whether the picker opens and the line takes the
  colour on the stage.
- Once the header's progress line has finished, tap a photo's sort tag in the strip ("interior", "detail"):
  a menu offers Exterior / Interior / Detail / Skip. Correct one and
  report whether the run honours it.
- In the booth, paste a dealer vehicle page address from the clipboard
  with nothing focused. Report whether the vehicle fields fill in. Then tap **A listing or VIN**, paste the address (or type
  a VIN): it reads on paste. Report whether the year, make and model
  fill in, with no network activity.

## 6. Library

- Tap **Library**, then **Open a listings folder**. On iOS this uses the
  plain folder picker. Report whether a folder from Files opens and
  whether hero tiles appear.

## Report

Paste the notes back as a message. Anything that failed, include the
exact text on screen. Screenshots help most for step 3.
