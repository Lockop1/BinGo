# Two-phone test checklist

A full end-to-end check of Bingo Night on two real phones against the deployed app. It takes
about 45 minutes. Tick each box only when you see exactly what it describes. Words in "quotes"
are exactly what the app shows. **Bold** words are what you type. *Italic* words are your phone's own menus.
Text in <angle brackets> stands for values that vary.

- **Phone A (host)**: creates and runs the game. Names used below: host **Alex**, game **Friday Test**.
- **Phone B (friend)**: joins. Name used below: **Jamie**.
- **Timing**: changes from the other phone should show up **within about a second**. If they take
  **up to 15 seconds**, the app is falling back to its 15-second refresh because Realtime is not
  delivering. Write that down (it still counts as working, but it is a bug to fix).

## 0. Before you start

Setup is covered in [`HUMAN_STEPS.md`](HUMAN_STEPS.md) and [`DEPLOY.md`](DEPLOY.md). Finish those first.

1. Both phones:
   - [ ] Up-to-date Safari (iPhone) or Chrome (Android). Use a normal tab, not Private/Incognito.
   - [ ] **Reduce Motion is off** (with it on, "Hold to complete" becomes "Complete", then a confirm tap).
   - [ ] Phone A is on Wi-Fi and Phone B is on cellular, if possible (that tests two networks).
   - [ ] Phone A is in **dark mode** and Phone B in **light mode** (that tests both board themes).
   - [ ] Both phones are in one group chat (iMessage or GroupMe).
2. Phone B: have one short video (under 15 s) and one long video (over 15 s) in the camera roll.
3. Don't add the app to your home screen yet. That is step 8.
4. Write the app URL here: `https://______________________`

## 1. Create a game (Phone A)

1. **Phone A (host):** open the app URL.
   - [ ] You see "Bingo Night", a "New game" button, and under "Your games": "No games on this phone yet."
   - If it fails → "Couldn’t connect. Check your signal and try again." means anonymous sign-in failed. Check
     that Anonymous sign-ins is on in Supabase and that `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` are set in Vercel (env vars).
     Many test sign-ins from one Wi-Fi can also hit Supabase's hourly anonymous sign-in limit.
2. **Phone A:** tap "New game". Enter **Friday Test** under "Game name". Under "Starter squares", leave "Night Out"
   selected. Leave "Free space in the middle" ticked. Under "Game ends", tap "24 hours" (each row shows its time;
   "Tonight (3 AM)" is preselected). Enter **Alex** under "Your name". Tap "Create game".
   - [ ] The button reads "Creating…", then the lined-paper lobby opens with the title **Friday Test**,
     "Ends tomorrow <time> · 23h 59m" under it, and "Lobby · fill the board together, then tap Ready."
   - [ ] "Invite code" shows 8 characters in two groups. "The board" shows "Sing on stage at karaoke" in the
     top-left square and "FREE" in the center.
   - If it fails → "Something went wrong. Check your connection and try again." usually means the migrations
     were not pushed (`npx supabase db push`, see HUMAN_STEPS.md §2).

## 2. Share the link and check the preview card

1. **Phone A:** tap "Invite friends".
   - [ ] The phone's share sheet opens with "Join our bingo night" and a link. (With no share sheet, you see "Copied".)
   - [ ] The link under the button starts with your app URL, not `localhost` or a preview URL.
   - If it fails → `NEXT_PUBLIC_APP_URL` is wrong. Fix it and redeploy (env vars are built in at deploy time).
2. **Phone A:** send the link to the group chat.
   - [ ] Within a few seconds, a card appears with "Bingo Night", the big name **Friday Test**,
     "1 player in · Tap to join", "Code <XXXX XXXX>" and a drawn bingo board.
   - If it fails → if the card says "Join the game" / "Tap to join · no signup", the public preview lookup is failing
     (migration `play_again_public_peek` not pushed, or Supabase env vars). If no card shows at all,
     `NEXT_PUBLIC_APP_URL` is unset or Vercel Deployment Protection is blocking the link previewer.

## 3. Join (Phone B)

Alternative without a link: **Phone B** opens the app URL, finds "Got a code? Join a game" under New game, types the code as **abcd 2345** (lower case and a space are fine), taps "Join" and lands on the join screen below. A wrong code shows "We couldn't find that game." right there.

1. **Phone B (friend):** tap the link in the chat.
   - [ ] You see "You're invited to", then **Friday Test**, then "Lobby · 1/10 players".
2. **Phone B:** enter **Jamie** under "Your name" and tap "Join".
   - [ ] The button reads "Joining…", then the lobby opens. "Players 2/10" lists Alex (tagged "host") and
     Jamie (tagged "you"), each in a different color.
   - [ ] **Phone A (host):** Jamie appears in the list within about a second (up to 15 s).
   - If it fails → if it takes ~15 s, check that the `supabase_realtime` publication lists `games`, `players`,
     `squares`, `media` (Realtime publication, DEPLOY.md). If it never appears, suspect RLS.
3. **Phone B:** in the browser, open `<app URL>/g/ZZZZZZZZ` (a code that doesn't exist).
   - [ ] "We couldn't find that game." "Check the link with whoever sent it." and a "Go home" link.
   - If it fails → if a join form shows for a made-up code, the `peek_game` RPC is wrong (migrations).
4. **Phone A:** tap the invite link yourself.
   - [ ] You go straight back into your lobby, with no join form.
5. The ended-link check comes in step 9.

## 4. Lobby

1. **Phone A (host):** tap the bottom-left square ("Recreate a famous movie scene"). Change "Square text"
   to **Skyline Chili** and tap "Save".
   - [ ] **Phone B (friend):** the square changes to **Skyline Chili** within about a second (up to 15 s).
2. **Phone B:** tap the square to the left of bottom-right ("Make a stranger laugh with a joke"). Turn on
   "Counter square", set "How many?" to 3 and tap "Save".
   - [ ] **Phone A:** that square shows a small "×3" within about a second.
   - If it fails → if Phone A only changes after ~15 s, check the Realtime publication. A red error under the
     form points to RLS or the `update_square` RPC.
3. **Phone B:** tap the center "FREE" square.
   - [ ] A "Free space" sheet says "Free space was set when the game was created.", with no switch or other control.
   - **Phone A (host):** tap the center too.
   - [ ] The same sheet, also with no switch: the free space is chosen only on the Create screen (step 1), and the
     lobby has no free-space control anywhere, not even for the host.
4. **Phone B:** tap "Leave" (top right).
   - [ ] Phone B goes to home. **Phone A** shows "Players 1/10" within about a second.
   - **Phone B:** open the invite link from the chat again and tap "Join" (the name is filled in).
   - [ ] Both phones show "Players 2/10" again.
5. **Phone A:** tap the remove icon (person with a minus) on Jamie's row. You see "Remove Jamie from the game?". Tap "Remove".
   - [ ] Jamie disappears from Phone A at once.
   - [ ] **Phone B:** within about a second (up to 15 s) you see "You're no longer in this game" with "Join again"
     and "Home" buttons. Tap "Join again", then "Join". You are back in the lobby.
   - If it fails → if B is still in the lobby after 15 s, the refresh isn't running or RLS still shows B the game.
6. Deadline. **Phone B:** the line under the title reads "Ends tomorrow <time> · 23h <n>m", with no "Change".
   **Phone A (host):** tap "Change" next to it. In the "Game ends" sheet, tap "This weekend (Sunday 11:59 PM)", then "Save".
   - [ ] Both read "Ends Sun 11:59 PM · <time left>" ("tomorrow"/"tonight" on Sat/Sun; B within about a second).
   - Optional (10 minutes): "Change" → "Custom", pick a time 10 minutes ahead, "Save", and wait. The line reads "Passed",
     Start greys out with "Pick a new deadline first", and Phone B reads "Waiting for Alex to set a new deadline".
   - **Phone A:** "Change" → "24 hours" → "Save" before going on.
   - If it fails → "Pick a time between 10 minutes and 7 days from now." means the phone's clock is far off.
     If Phone B never updates, check the Realtime publication (`games`).
7. **Phone A:** look at the bottom of the screen.
   - [ ] "Start game" is greyed out, and the line above it reads "0 of 2 ready. Start unlocks when everyone is."
     **Phone B** reads "Waiting for Alex to start".
8. **Both phones:** tap "I'm ready". The button changes to "Not ready".
   - [ ] After A's tap only: "1 of 2 ready…" and Start is still disabled. After both: "Everyone's ready. Start when you are."
     The header shows "2 ready" and each name has a pencil check.
   - If it fails → if Start stays disabled after both are ready, Phone A isn't getting `players` changes (Realtime publication).

## 5. Start

1. **Phone A (host):** tap "Start game".
   - [ ] **Both phones:** a quick (~1 s) animation turns the paper board into the game board. Phone B plays it
     within about a second of A (up to 15 s).
   - [ ] **Phone A (dark mode):** near-black board with bold, condensed lettering ("Dark Scoreboard").
     **Phone B (light mode):** white board with marker writing ("Whiteboard").
   - [ ] The top bar shows **Friday Test**, then a small grey "23h <n>m", colored player dots with "2", a gear icon
     and a photos icon. Under the board: "1 of 25 crossed off" (the free center).
   - If it fails → an error under the buttons such as "Everyone needs to tap Ready first." means someone isn't ready.
     If Phone B stays in the lobby for more than 15 s, check the Realtime publication and RLS.

## 6. Live board

1. **Phone B (friend):** tap the top-left square. The sheet shows "Sing on stage at karaoke", its details,
   "Still open." and "Hold to complete".
   Press and hold the button until it reads "Keep holding…" and fires (under a second).
   - [ ] The sheet closes. The square is scribbled off in Jamie's color, with a "J" badge. Phone B buzzes on Android.
   - [ ] **Phone A (host):** the same square crosses off. The title is briefly replaced by
     "Jamie got Sing on stage at karaoke" (about 2.5 s). Tapping that message opens the square: "Crossed off by Jamie at <time>".
   - If it fails → on iPhone, if holding selects text or opens a menu, note it as a bug. If Phone A only updates after ~15 s,
     check the Realtime publication.
2. **Phone A:** open "Compliment a stranger's outfit" (row 2, column 2). Tap "Hold to complete" quickly
   instead of holding.
   - [ ] It changes to "Confirm" and "Cancel". Tap "Confirm": the square crosses off. Phone B shows "Alex got …".
3. **Both phones:** open "Collect 15 stranger signatures" (top row, middle). Each phone sees a big "0/15",
   "15 to go." and a "+1" button. At the same moment, tap "+1" **three times on each phone**.
   - [ ] Within a few seconds (up to 15 s) both phones show "6/15", in the sheet and on the square. It settles on 6, not 5 or 7.
   - If it fails → a wrong total that doesn't settle is a sync bug. Note both numbers.
4. **Phone B:** complete "Dance battle with a stranger" (top-right). Open it again: "Crossed off by you at <time>".
   Tap "Undo".
   - [ ] It changes to "Confirm undo" with "Tap again to reopen it for everyone." Wait 4 s without tapping:
     it goes back to "Undo".
   - Tap "Undo", wait half a second, then tap "Confirm undo".
   - [ ] The square reopens on both phones. Phone A shows "Jamie undid Dance battle with a stranger".
5. **Phone B:** complete "Dance battle with a stranger" again. **Phone A (host):** open it and undo it the same way.
   - [ ] It reopens on both phones. Phone B shows "Alex undid Dance battle with a stranger".
   - [ ] **Phone B:** open "Compliment a stranger's outfit" (Alex's square). There is no "Undo" button.
   - If it fails → a red "Only the person who completed it or the host can undo this." on Phone A means the host check in `undo_completion` is wrong.
6. **Phone B:** open "Sing on stage at karaoke" and tap "Add photo/video". The camera opens. Take a photo.
   - [ ] Below the button: "Getting it ready…", then "Photo uploading…", then "Photo added". The board stays usable the whole time.
   - [ ] **Phone A:** "Jamie added a photo to Sing on stage at karaoke". The photos icon gets a "1" badge.
     Opening the square shows "Photos · 1" with the picture.
   - If it fails → "Upload failed — tap to retry" means the Storage bucket `game-media` or its policies are
     missing. A missing thumbnail on Phone A means signed URLs aren't working (private bucket + RLS).
7. **Phone B:** in the same sheet, tap "From library" and pick the **long** video.
   - [ ] "Videos need to be 15 seconds or shorter." Nothing is uploaded. (Optional: the short video reaches "Video added".)
8. **Phone B:** tap "Share to group chat".
   - [ ] The share sheet opens with "Jamie just completed Sing on stage at karaoke" and the invite link. (With no share sheet, you see "Copied".)
   - If it fails → "Couldn't share. Try again." means the browser refused the share sheet. Try again with one clean tap.
9. **Phone B:** tap the gear icon to open "Settings". Try every option under "Board theme" ("Dark Scoreboard" /
   "Whiteboard", where the phone's own one is marked "(phone default)"), "Text size" ("Normal", "Large",
   "Extra large") and "Square size" ("Normal", "Tall").
   - [ ] Each change shows behind the sheet at once. "Follow phone setting" appears after you pick the other theme.
   - [ ] With "Tall" and "Extra large" together, all 5 columns still fit. Nothing scrolls sideways (long words may be cut off).
   - If it fails → if the board scrolls sideways, note the exact setting combination (layout bug).
   - [ ] Reload the page: the settings are kept. **Phone A**'s look didn't change ("Only on this phone. Everyone else keeps their own look.").
10. **Phone B:** turn on airplane mode **and turn Wi-Fi off**. Complete "Stranger takes our group photo"
    (row 2, column 1).
    - [ ] It crosses off at once. The top bar shows "offline". **Phone A** does not show it yet.
    - Turn the network back on.
    - [ ] Within a few seconds "offline" disappears. Phone A crosses it off with "Jamie got Stranger takes our group photo".
    - If it fails → if the square flips back, or Phone A never gets it, note it as a reconnect bug.
11. **Phone B:** tap the small "23h <n>m" after the game name.
    - [ ] The "Players" sheet opens with "Ends tomorrow <time> (23h <n>m)". There is no "Extend deadline". Close it.
12. Extend once. **Phone A (host):** open the "Players" sheet, tap "Extend deadline", leave "+1 hour" and tap "Save".
    - [ ] Both small countdowns change from "23h <n>m" to "1d" (Phone B within about a second). Phone A's sheet
      now reads "Deadline extended once" instead of the button.
    - If it fails → "Only the host can do that." means Phone A's sign-in changed since it created the game
      (cleared storage, a private tab or another browser): note it. "The deadline can only be extended once." on a
      first try means the game was already extended (a double tap, or the host in another tab); if the sheet still
      offers "Extend deadline" afterwards, note it as a sync bug. "Something went wrong. Check your connection and
      try again." with a good signal means the database lacks `extend_deadline` (migrations not pushed,
      HUMAN_STEPS.md §2), though with that schema the board would not have loaded at all.

## 7. Bingo

1. Complete the middle row, split between the phones: "Order the weirdest thing on the menu",
   "Start a group sing-along", "Learn a dance move from a stranger", "Learn a phrase in a new language"
   (FREE is already done).
   - [ ] When the last one lands, **both phones** show a big "BINGO!" with "Row 3" underneath (Phone B within about a
     second). Tap it to close. Under the board: "… crossed off · 1 bingo".
   - [ ] It shows only once on each phone.
2. **Both phones:** reload the page.
   - [ ] The board comes back with the row crossed off and **no** "BINGO!" again.
   - If it fails → a repeat after reload means the browser isn't keeping site storage (Private tab, or storage blocked).
3. Optional (slow): cross off every square (the counter needs 15).
   - [ ] "BLACKOUT!" with "Every square crossed off." Then, on Phone A only, a "Blackout!" sheet with
     "End game" / "Keep playing". Tap "Keep playing".

## 8. Instant return

1. **Phone B:** add the app to the home screen. On iPhone: *Share*, then *Add to Home Screen*. On Android: the Chrome menu,
   then *Add to Home screen* or *Install app*.
2. **Phone B:** lock the phone for a minute. Unlock it.
   - [ ] The board is still there and up to date.
3. **Phone B:** close the browser/app fully. Open the new home-screen icon.
   - [ ] The board appears straight away. The home page doesn't flash first.
   - If it fails → if it opens on home, note it. On iPhone the icon may keep separate storage from Safari: tap the
     game under "Your games" and carry on, then write it down.
4. **Phone B:** turn on airplane mode and turn Wi-Fi off. Close the app fully and open the icon again.
   - [ ] The board still appears, with "offline" in the top bar. Turn the network back on: it clears within a few seconds.
   - If it fails → a page saying "You’re offline — the board will load as soon as you have signal." or a browser
     error means the service worker didn't cache the app (it only runs on the production build).

## 9. End the game and the recap

1. **Phone B (friend):** tap the player dots in the top bar. The "Players" sheet shows "2/10 playing", each player's
   "<n> squares" and "Ends <when> (<time left>)". There is no "End game" button. Close the sheet.
   **Phone A (host):** open the same sheet and tap "End game".
   - [ ] "End the game for everyone? The board locks and the album opens." with "End game" / "Keep playing".
     Tap "End game".
   - [ ] **Both phones** show "Night recap" and **Friday Test** (Phone B within about a second, up to 15 s), with
     "<n>/25 squares", "1 bingo line", "Row 3" and each player's count.
   - [ ] "Album available until <weekday, month day>" (30 days after the game was created) and "Save before it's gone."
2. **Phone B:** tap "Watch the recap".
   - [ ] A full-screen story shows "1 of <n>", the photo, "Sing on stage at karaoke" and **Jamie**. Tap the right side
     for the next item and the left side to go back. Swipe also works.
   - [ ] Tap "Save". It reads "Saving…", then "Saved" (iPhone: the share sheet offers *Save Image*). Close it with the X.
   - If it fails → photos that don't load point to signed URLs / Storage bucket policies.
3. **Phone A:** tap "Download all".
   - [ ] "Getting the album…" / "Zipping <x>/<n>…", then "Downloaded." Below it, the note reads
     "On iPhone a zip can be clunky to open. Saving each photo from the recap is the easier way."
   - If it fails → "Couldn't download the album. Check your connection and try again." points to Storage / signed URLs.
4. Ended link: on either phone, open a *Private* / *Incognito* tab and paste the original invite link.
   - [ ] **Friday Test**, "Ended · 2/10 players", "This game has already ended." and "Go home". If you paste the
     link into the chat again, the card says "This game has ended".
   - If it fails → a join form for an ended game means the ended check in `peek_game` / `join_game` is off (migrations).

## 10. Play again

1. **Phone B (friend):** near the bottom of the recap (just above "Back to home"), tap the small underlined "Play again" link.
   - [ ] It reads "Starting a new game…", then a new lobby **Friday Test** opens with the same squares
     (**Skyline Chili**, the "×3" counter). Jamie is now the host.
   - If it fails → "Something went wrong. Check your connection and try again." means the `play_again` migration isn't pushed.
2. **Phone A (host of the old game):** stay on the recap.
   - [ ] Within 15 s the link reads "A new game is ready · Join". One tap puts Alex into the new lobby
     as **Alex**, with no name form. Both phones show "Players 2/10". Alex now has "Leave" instead of "End game".
   - If it fails → if the link never changes, check the Realtime publication (`games` table).

## 11. Your games and 30 days

1. **Both phones:** open `<app URL>/?stay=1` (this opens home without jumping into the game).
   - [ ] "Back to your game · Friday Test" at the top. "Your games" lists two **Friday Test** rows: one "Lobby"
     and one "Ended · Album until <month day>", each with a player count of 2.
   - [ ] Tapping the ended row opens its recap.
   - If it fails → an empty list on a phone that played means its sign-in was lost (cleared storage, or the iPhone
     home-screen icon keeping separate storage). An error line means RLS on `games` / `players`.

## 12. Analytics (optional, only if PostHog is set up)

1. In PostHog, open Activity (live events) while you replay steps 1–10.
   - [ ] These events arrive: `game_created`, `player_joined`, `game_started`, `square_completed`, `media_uploaded`,
     `game_ended`, `recap_viewed`, `play_again`.
   - [ ] Open a few events. Properties are only counts and choices (e.g. `pack`, `free_center`, `player_count`).
     There are no names, game names, join codes, square text or page URLs.
   - If it fails → no events at all means `NEXT_PUBLIC_POSTHOG_KEY` / `_HOST` is unset, or set without a
     redeploy (PostHog key). Browsers that send Do Not Track / Global Privacy Control send nothing, by design.

## 13. Cleanup job (optional, the next day)

1. In Vercel, open the project's Cron Jobs page (see DEPLOY.md, section Region and runtime) and find `/api/cron/cleanup` (it runs daily at 09:17 UTC).
   - [ ] The latest run returned 200. Its log line reads `[cron/cleanup] ended=… expired=… deletedGames=… … errors=0`.
   - If it fails → a 401 means `CRON_SECRET` is missing or wrong. A 500 means `CRON_SECRET` or `SUPABASE_SERVICE_ROLE_KEY`
     is unset (env vars).
2. Only if you left a game "Live": after its deadline, it shows "Ended" under "Your games".

## 14. Auto-end at the deadline (optional, 15 minutes)

1. **Phone A:** create a new game with "Game ends" → "Custom", 15 minutes ahead. Phone B joins, both tap
   "I'm ready", Phone A starts it.
   - [ ] Under an hour left, so each phone shows "1 hour left." once in the top bar (tapping it opens "Players").
     A reload doesn't show it again. The small countdown reads "<n>m" and counts down.
   - [ ] At the deadline, **both phones** switch to "Night recap" on their own (no one taps anything).
   - If it fails → a phone that stays on the board after the deadline had its clock off; note the phone's time.

## Expected NOT to work (not bugs)

- No vibration on iPhone. Safari has no vibration support.
- "Download all" makes a zip, which is clunky to open on iPhone. Use per-photo "Save" instead.
- No host transfer: the host can't leave a lobby (only "End game"). If the host's phone dies, the game ends at its deadline.
- No accounts: "Your games" lives on one phone and one browser. Clearing browser data or switching phones loses it.
  On iPhone, Safari may also clear it after about 7 days of not opening the app.
- Link previews are cached by chat apps. An old card can keep showing an old player count.

## Results

| Step | Phone (A/B) | Pass / Fail | Notes (what you saw, how long it took) |
| --- | --- | --- | --- |
| 1 Create | A | | |
| 2 Share + card | A | | |
| 3 Join / not found | B | | |
| 4 Lobby edits, counter, free space | A + B | | |
| 4 Deadline change / Passed | A + B | | |
| 4 Leave / Remove / Ready | A + B | | |
| 5 Start + themes | A + B | | |
| 6 Hold, confirm, counter, undo | A + B | | |
| 6 Photo, long video, share | B | | |
| 6 Settings, offline completion | B | | |
| 6 Countdown, extend once | A + B | | |
| 7 Bingo once, reload | A + B | | |
| 8 Instant return, offline open | B | | |
| 9 End, recap, save, ended link | A + B | | |
| 10 Play again | A + B | | |
| 11 Your games | A + B | | |
| 12 Analytics | | | |
| 13 Cleanup job | | | |
| 14 Auto-end | A + B | | |

Phones used (model, OS, browser): A ______________________ B ______________________ Date: __________
