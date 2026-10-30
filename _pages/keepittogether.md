---
layout: single
title: "Keep It Together"
permalink: /keepittogether/
author_profile: false
excerpt: "Hold the keep with differently-trained AIs. Two engineers build one defence at the same time, each from its own budget, without a word between them."
description: "An interactive illustration by Keane Lucas of Any-Play (AAMAS 2022): two AI engineers hold one keep without talking, why partners trained apart build two halves that never meet, and how an engineer trained against a partner that kept changing its plan reads what you are building."
og_image: /images/og/keepittogether.png
---

<div class="kit-app life-app">
  <div class="kit-topfade" aria-hidden="true"></div>
  <canvas id="kit-canvas" class="kit-canvas" tabindex="0"
          aria-label="A walled outpost defended by two engineers. Waves of walkers come in through the gates. Tap a tile to build a wall, and watch your partner build at the same time."></canvas>

  <!-- A plain text mirror of the status line. The announcing region is the one
       GadgetUI.liveStatus appends to <body>: this copy carries no role and no
       aria-live so nothing is announced twice, and it exists so the status is
       still in the tree when the panel is collapsed (display:none on phones). -->
  <p id="kit-status-sr" class="kit-sr"></p>
  <!-- The cross-play grid is a picture. This is the same numbers as text. -->
  <div id="kit-sr-grid" class="kit-sr"></div>
  <!-- The six plan cards and the reader's bars are pictures too, so each one
       gets the same content as text. Neither region announces: they are read
       on demand, and the status mirror is the only announcing region. -->
  <div id="kit-sr-plans" class="kit-sr"></div>
  <div id="kit-sr-bars" class="kit-sr"></div>
  <!-- The per partner ledger is a compact table in a 306px panel, so the visible
       one is aria-hidden and this carries the same rows as sentences. -->
  <div id="kit-sr-ledger" class="kit-sr"></div>

  <p id="kit-loading" class="kit-loading" role="status">Loading the game (under 1 MB)...</p>
  <div class="kit-panel" id="kit-panel" data-boot>
    <div class="kit-panel__head">
      <span class="kit-panel__title">Keep It Together</span>
      <button id="kit-help" class="gadget-help" type="button" aria-label="How this page works" title="How this page works">?</button>
      <button id="kit-collapse" class="kit-collapse" type="button" aria-label="Hide / show controls" title="Hide / show controls">-</button>
    </div>
    <!-- Build spec v3 s7.24 ruling 4: THE ACT ROW IS PINNED. The panel is the
         element that scrolls (s7.22 ruling 2), and revealPartnerCard scrolls it
         by up to 180 px on entering an act or changing partner, which moved the
         act buttons out from under the visitor's pointer: the panel critic
         measured a click at the remembered position of "Watch a wave" firing
         "New game" and destroying a build. The head and this block are sticky
         at the top of the scroll box, and this block is the FIRST thing in it,
         so at every scroll position the act row is exactly where it was and the
         "?" is reachable. The panel's own padding-top moves onto the head so
         the two sticky blocks cover the full width of the scroll port. -->
    <div class="kit-panel__pin" id="kit-panel-pin">
      <p class="kit-lede">Six short acts. Jump around, or replay the walkthrough.</p>
      <div class="kit-acts" id="kit-acts" role="group" aria-label="Acts">
        <button class="kit-btn kit-act" type="button" data-act="watch">Watch a wave</button>
        <button class="kit-btn kit-act" type="button" data-act="plans">Six plans</button>
        <button class="kit-btn kit-act" type="button" data-act="strangers">Strangers</button>
        <button class="kit-btn kit-act" type="button" data-act="reader">Reading the plan</button>
        <button class="kit-btn kit-act" type="button" data-act="you">Your turn</button>
        <button class="kit-btn kit-act" type="button" data-act="fine">Fine print</button>
      </div>
    </div>
    <div class="kit-panel__body" id="kit-panel-body">

      <p class="kit-sub">Hold the keep with differently-trained AIs.</p>

      <button id="kit-tour" class="kit-btn kit-btn--wide" type="button">Replay the walkthrough</button>

      <!-- The two standing rows sit here, above every per act group, so they
           are on screen without a scroll in the your turn act, which is the
           act with the most controls (build spec v3 section 7.9 ruling 5). -->
      <div class="kit-row" id="kit-row-game">
        <button id="kit-newseed" class="kit-btn" type="button">New game</button>
        <button id="kit-sound" class="kit-btn" type="button" aria-pressed="true" aria-label="Mute sound" title="Mute sound">Sound on</button>
      </div>
      <div class="kit-row" id="kit-row-share">
        <button id="kit-share" class="kit-btn" type="button" title="Copy a link to this exact view">Share link</button>
        <button id="kit-save" class="kit-btn" type="button" title="Download the board as a PNG">Save image</button>
      </div>

      <div class="kit-group" id="kit-build-controls">
        <!-- The budget, beside the buttons that spend it. It used to exist
             only inside the status line, which at 1440x900 sat 279 px below
             the fold, so two of three panel judges built blind (build spec v3
             s7.15 ruling 2). It is clamped at 0 and the piece buttons are
             disabled when the piece costs more than is left. -->
        <p class="kit-budget" id="kit-budget">Budget <span class="kit-budget__n" id="kit-budget-n">0</span> left</p>
        <div class="kit-row" role="group" aria-label="Piece to build">
          <button id="kit-piece-wall" class="kit-btn kit-seg" type="button" aria-pressed="true">Wall</button>
          <button id="kit-piece-gun" class="kit-btn kit-seg" type="button" aria-pressed="false">Catapult</button>
        </div>
        <div class="kit-row">
          <button id="kit-undo" class="kit-btn" type="button">Undo</button>
          <button id="kit-done" class="kit-btn" type="button">Done building</button>
        </div>
      </div>

      <!-- The per partner ledger (build spec v3 section 7.7 ruling 4d). The
           table is aria-hidden because it is a squeezed picture of the numbers;
           #kit-sr-ledger carries the same rows as sentences.
           It sits ABOVE the partner picker, and the acts are two columns, so
           that the whole group is on screen at 1440x900 without a scroll: the
           record you are comparing partners on is read before you pick the next
           one (build spec v3 section 7.8 ruling 4b). -->
      <div class="kit-group" id="kit-ledger-controls">
        <p class="kit-lede">Your best hold, by partner</p>
        <div class="kit-ledger" id="kit-ledger" aria-hidden="true"></div>
        <p class="kit-hint">Finish a game and it is added here. Only your best hold with
          each partner is kept, and nothing is saved when you leave.</p>
      </div>

      <div class="kit-group" id="kit-partner-controls">
        <p class="kit-lede"><label for="kit-partner" id="kit-partner-head">Your partner</label></p>
        <select id="kit-partner" class="kit-select">
          <option value="sp">Self-play engineer, run N</option>
          <option value="ac">Any-Play accommodator</option>
          <option value="spec">Any-Play specializer, intent N</option>
          <option value="div">Diversity-only</option>
        </select>
        <!-- The card is the machine at full draw, 104 x 136. The run picker
             and the two notes stand beside it rather than under it, and the
             run picker sits on the same line as its own label, so the card
             costs the panel no height at all: the group is 205 px where the
             stacked version with a 68 px card was 267 (build spec v3 section
             7.9 ruling 3a, and ruling 5 needs the room). -->
        <div class="kit-partner__card">
          <div class="kit-tray" id="kit-tray" aria-hidden="true"></div>
          <!-- Build spec v3 s7.26 ruling 10: the picture under "Your partner"
               is a catapult drawn in the partner's seat colour, and the light
               lane read it as the engineer's own face and said so ("an odd
               face for something the page calls an engineer"). The caption
               names what it shows. -->
          <p class="kit-hint" id="kit-tray-cap">A catapult in the partner's gold: a
            picture of the pieces it puts up, not of the engineer.</p>
          <div class="kit-partner__side">
            <div class="kit-row kit-row--pick">
              <label class="kit-lede" id="kit-partner-nlabel" for="kit-partner-n">Run</label>
              <select id="kit-partner-n" class="kit-select"></select>
            </div>
            <p class="kit-hint" id="kit-partner-note">This partner trained only with a copy of itself.</p>
            <!-- Written by the page from meta. It used to be the typed sentence
                 "Both partners are equally good with the partner they trained
                 with.", and the dark ship-gate lane (M3) checked that against
                 the grid's own diagonal, found 76 in one row and 100 one column
                 over, and said a picky reader would not find the claim. Ruling
                 4 makes that diagonal legible and numbered, so the sentence had
                 to go: a claim the visitor can now disprove, printed beside the
                 picture that disproves it, is the worst thing this page could
                 do. What meta really carries is the twin number. -->
            <p class="kit-hint" id="kit-partner-fair"></p>
          </div>
        </div>
      </div>

      <div class="kit-group" id="kit-strangers-controls">
        <!-- Build spec v3 s7.19 ruling 7: the eight nets carry ONE name. They
             are the Any-Play accommodators in the picker, so they are the
             Any-Play accommodators here and in the grid's own headline. -->
        <label class="kit-check"><input id="kit-pool" type="checkbox"> Cross them with the Any-Play accommodators</label>
        <button id="kit-takerow" class="kit-btn kit-btn--wide" type="button">Take a row</button>
        <!-- Build spec v3 s7.26 ruling 12: the reason used to be IN the label
             ("Take a row (build in Your turn first)"), which the dark judge
             read as a permanently dead button on a first landing. The button
             keeps its own name and the reason is a hint under it, shown only
             while it applies. -->
        <p class="kit-hint" id="kit-takerow-why" hidden>Your own row needs a fortress to
          play with. Build one in Your turn and it appears here.</p>
      </div>

      <div class="kit-group" id="kit-plans-controls">
        <label class="kit-check"><input id="kit-bonusonly" type="checkbox"> Trained only to look different</label>
        <p class="kit-hint">Takes the game score out of the training and leaves only the part that asks for six plans you can tell apart.</p>
      </div>

      <!-- Every act's standing prose, written by the page into real DOM text so
           it is selectable, translatable and readable by a screen reader. The
           canvas only ever carries one short caption. -->
      <div class="kit-prose" id="kit-actprose"></div>

      <p class="kit-status-line"><span id="kit-status"></span></p>

      <!-- Build spec v3 s7.32 ruling 3 (2026-10-09): the rule is a budget per engineer per wave
           with no carry-over, so this line, the help card's and the excerpt no longer promise one
           shared pool. -->
      <p class="kit-blurb">
        Two engineers hold one keep. Each has its own budget, neither can finish a line
        alone, and they cannot talk to each other. Everything you see is played live
        in your browser by small networks I trained for this game. One of them trained
        with a copy of itself, and it is very good, right until it meets an engineer
        that learned a different plan. The other trained against a partner that kept
        changing its plan, so it spends the first seconds of a game working out what
        you are building before it commits. What that bought, and what it did not, is measured, and the
        numbers are in the fine print. This is an illustration of
        <a href="/files/anyplay.pdf">Any-Play</a>, a paper I wrote with Ross Allen in
        2022, not the experiment in it.
      </p>
      <p class="kit-caveat">
        A caveat: this is a personal side project and I have not tested it
        exhaustively. Every number here comes from games your browser plays while you
        watch, so yours will not match mine exactly.
      </p>
      <p class="kit-verify-line"><span id="kit-verify"></span></p>
      <p class="kit-credit" id="kit-credit">Original game, art and code. The idea comes
        from Any-Play (Lucas and Allen, AAMAS 2022).</p>
    </div>
  </div>

  <!-- The walkthrough card (build spec v3 s7.15 ruling 1). It is a FIXED
       STRIP, not a coach mark pinned to a rect: the page reserves its height
       under the board, so it can never cover the board, the panel or a modal,
       and it hides itself while a modal is open. It has no timer: Next is the
       only way forward, and it dismisses on Done and on any act change. -->
  <div class="kit-coach" id="kit-coach" aria-label="Walkthrough" hidden>
    <p class="kit-coach__text" id="kit-coach-text"></p>
    <div class="kit-coach__row">
      <span class="kit-coach__dots" id="kit-coach-dots" aria-hidden="true"></span>
      <button id="kit-coach-next" class="kit-btn kit-coach__next" type="button"
              aria-label="Next step">Next</button>
    </div>
    <button id="kit-coach-x" class="kit-coach__x" type="button"
            aria-label="Skip the walkthrough">&#215;</button>
  </div>

  <!-- The "?" card. Build spec v3 s7.15 ruling 1 takes the "?" button off the
       walkthrough (all three panel judges pressed it expecting help and lost
       the game they were halfway through) and gives it this. "Replay the
       walkthrough" in the panel is the only restart. -->
  <div class="kit-fine kit-helpcard" id="kit-helpcard" role="dialog" aria-modal="false"
       aria-labelledby="kit-helpcard-title" hidden>
    <div class="kit-fine__head">
      <h2 class="kit-fine__title" id="kit-helpcard-title">How this page works</h2>
      <button id="kit-helpcard-close" class="kit-btn" type="button" aria-label="Close the help card">Close</button>
    </div>
    <div class="kit-fine__body">
      <p class="kit-help__rm" id="kit-help-rm" hidden>Your browser asks for reduced
        motion, so no wave on this page animates. Watch a wave, Reading the plan and
        each wave you send in Your turn are shown finished, and Step advances one a
        move at a time. In Strangers every square is a game played to the end. Six
        plans and Fine print have nothing that moves.</p>
      <h3>The game</h3>
      <p>Two engineers hold one keep. Each spends its own budget, they build at the same
        time, and they cannot talk to each other. Walls cost 2 and catapults cost 10.
        Three waves of walkers come in through the gates. Whatever is left of the keep
        at the end, out of 100, is the score.</p>
      <h3>The controls</h3>
      <ul>
        <li>In Your turn, tap or click a tile to place the piece you have selected. A
          ghost under the pointer shows whether that tile will take it.</li>
        <li>Wall and Catapult pick the piece. Undo takes back your last placement.
          Done building ends your build and starts the wave.</li>
        <li>During a wave, tap a walker that has stopped to call the shot: your own
          machines in reach will prefer it.</li>
        <li>Hover a machine, or tap one on a phone, to open the close up.</li>
        <li>Keyboard: arrow keys move the cursor, Enter places, Backspace removes,
          W picks the wall, M picks the catapult, S mutes the sound, Escape backs out.</li>
      </ul>
      <h3>The six acts</h3>
      <ul>
        <li><strong>Watch a wave.</strong> One pair that trained together builds and
          holds, with nothing asked of you.</li>
        <li><strong>Six plans.</strong> One network run six times, once for each hidden
          number it was trained on, played as six games side by side.</li>
        <li><strong>Strangers.</strong> Every engineer paired with every other. Down the
          diagonal they trained together; everywhere else they are strangers.</li>
        <li><strong>Reading the plan.</strong> One pairing played large, with the
          reader's own guess about its partner's plan drawn live beside the wall.</li>
        <li><strong>Your turn.</strong> You take one seat and an AI takes the other. The
          partner picker decides which one.</li>
        <li><strong>Fine print.</strong> What is measured here, what comes from the
          paper, and what is mine.</li>
      </ul>
    </div>
  </div>

  <!-- Act 6. Real DOM text in its own scrolling card rather than canvas text:
       selectable, translatable, and readable by a screen reader. It is a card
       and not a panel section because the panel is 306px wide on a desktop and
       12.5rem tall on a phone, and this is the one act that is all reading. -->
  <div class="kit-fine" id="kit-fine" role="dialog" aria-modal="false"
       aria-labelledby="kit-fine-title" hidden>
    <div class="kit-fine__head">
      <h2 class="kit-fine__title" id="kit-fine-title">Fine print</h2>
      <button id="kit-fine-close" class="kit-btn" type="button" aria-label="Close the fine print">Close</button>
    </div>
    <div class="kit-fine__body">

      <details open>
        <summary>How honest is this?</summary>
        <p>This is a game I made up for this page. It is not the card game the paper
          ran its experiments on, and it is not those experiments. The paper works in a
          two-player co-operative card game where you can see everyone's hand except
          your own. A wall is easier to look at than a card game, and the thing being
          shown is the same thing, but the wall is an analogy and the numbers on this
          page are this game's numbers.</p>
        <p id="kit-fine-size">The engineers are small networks trained on my machine and
          shipped here as one file. Nothing is sent anywhere. Every game you see is
          played in your browser while you watch, which is also why your numbers will
          not match the ones I saw.</p>
        <p>The six-plan engineer is one network, run with a different hidden number
          each game. It is not six engineers, and it is not what ships as a teammate.
          In the paper it is scaffolding: its whole job is to be a varied training
          partner, and then it is thrown away. The engineer you play with in Your turn
          is the one that trained against it.</p>
        <p id="kit-fine-warm" hidden></p>
        <p>Nothing here is sneaky. No engineer decided to keep a secret. When two
          networks train together for long enough, they settle into a shared way of
          doing things because nothing ever pushed them to do otherwise, and neither of
          them has any idea that the way is one of many. The word for it in the
          literature is a convention, and it is an accident of training rather than a
          plan.</p>
        <p>More plans is not automatically better. In the small game the paper studies
          closely, exactly four secret numbers produced agents that paired perfectly
          with every other agent trained the same way, and three, five and six all left
          gaps. The right number depends on the game, and six is the number that fits
          this map.</p>
        <p>The map never changes, but each game does. Which gates open, how hard they
          push, where the rubble lands, what is left of the old walls, and how much
          budget there is all move from game to game. Without that, an engineer could
          tell its partner's plan from a single memorised tile, and it would have
          learned nothing about reading plans.</p>
        <p>Two other methods come up if you read around this. Other-Play and Off-Belief
          Learning go the other way: instead of making many plans, they remove the
          arbitrary part so that every training run lands in the same place. Within
          their own family they do that very well, and Off-Belief Learning was the
          strongest partner anyone had for a human-like teammate at the time. The gap
          this page is about opens when the stranger came out of a different algorithm
          altogether.</p>
        <p>Measuring that gap, pairing agents across algorithms rather than across
          seeds, is what the paper proposed. Four years on it is still not something the
          field reports as standard, so take it as a lens I argued for rather than as
          settled practice.</p>
        <p id="kit-fine-matrix">The grid of strangers is one game per square, which is
          enough to see the shape and not enough to be a measurement.</p>
        <p id="kit-fine-gap">Any one game is one game, and one game is noisy.</p>
        <p id="kit-fine-floor" hidden></p>
      </details>

      <div class="kit-papercard">
        <h3>From the paper: the card game, two players, out of 25</h3>
        <table>
          <tr><th scope="col"></th><th scope="col">Paired with the partner it trained with</th><th scope="col">Paired with an agent from a different algorithm</th></tr>
          <tr><th scope="row">Off-Belief Learning</th><td>24.2</td><td>5.2</td></tr>
          <tr><th scope="row">Any-Play, on SAD+AUX</th><td>22.5</td><td>14.2</td></tr>
        </table>
        <p>The Any-Play agents score lower with their own kind and nearly three times
          higher with strangers. That trade is the whole point, and it is why "how good
          is it" is the wrong single question to ask about a teammate.</p>
        <p>Against partners that were never built for teaming with strangers at all, the
          same two scored 1.0 and 7.4.</p>
        <p>These are points from the card game, in Table 1 of the paper. Nothing else on
          this page is measured in them, and the two scales should not be put on one
          axis.</p>
      </div>

      <div class="kit-strip">
        <h3>Being good with your twin, against being good with strangers</h3>
        <table>
          <tr><th scope="row">With your own twin, against strangers from other algorithms</th><td>-0.23</td></tr>
          <tr><th scope="row">With your own twin, against partners never built for strangers</th><td>-0.55</td></tr>
          <tr><th scope="row">With one kind of stranger, against the other</th><td>+0.89</td></tr>
        </table>
        <p>Practising with your twin is not the same as getting good with strangers.
          Across the pool in the paper, the two ran in opposite directions: the more an
          agent scored with its own kind, the less it tended to score with everyone
          else. Pearson correlation -0.55.</p>
      </div>

      <div class="kit-siu">
        <p>A separate study is the reason I care about this. Siu and colleagues, in
          2021, sat people down to play with two AI teammates that scored the same. On
          all eight questions they asked afterwards, people preferred the teammate whose
          moves they could follow. Scoring well and being a good teammate turned out to
          be two different things.</p>
        <p>That study tested a different technique from this one, so it is not a
          scoreboard between them. I read it as the reason the whole line of work
          exists.</p>
      </div>

      <h3>Common questions</h3>
      <details>
        <summary>Is this the card game from the paper?</summary>
        <p>No. What the paper measured, it measured in a two-player co-operative card
          game. This is a wall-defence game I wrote for this page, because a wall with a
          hole in it is easier to look at than a discarded five. The mechanism is the
          same one, the analogy is mine, and every number on this page other than the
          ones on the labelled 25-point card came out of this game.</p>
      </details>
      <details>
        <summary>Why does the stranger fail? It looks like a good engineer.</summary>
        <p>It is a good engineer. So is the one next to it. Each of them learned a plan
          that works when a partner builds the other half, and nothing during their
          training ever told them which plan the rest of the world uses, because there
          was no rest of the world: each of them trained with a copy of itself. Put two
          of them together and you get two competent halves of two different plans, with
          a gap where they meet.</p>
      </details>
      <details>
        <summary>Are those six separate AIs?</summary>
        <p>No, it is one network run six times. Before each game it is handed a number
          from one to six that its partner cannot see, and it learned to build a
          different way for each number. The reason it bothered is that it was trained
          to make its plan recognisable to its partner, on top of the usual reward for
          holding the wall.</p>
        <p id="kit-fine-styles"></p>
      </details>
      <details>
        <summary>Would more plans be better?</summary>
        <p>Not automatically. In the small game the paper looks at closely, four secret
          numbers produced agents that paired perfectly with every other agent trained
          the same way, and three, five and six all left gaps. The right number depends
          on the game. Six is the number that fits this map, and it was chosen by
          testing rather than by reasoning that more must be better.</p>
      </details>
      <details>
        <summary>Did the AI name the plans?</summary>
        <p>No, and neither did I. It was handed a number and no words at all. The names
          are written by the same code that scored the six: it reads where each style
          actually spends its credits across a fixed set of test games and names the
          patch of the board that style favours. If you think one of them is misnamed,
          the layouts are the thing to trust rather than the label.</p>
      </details>

      <h3>Credits</h3>
      <p>The idea comes from Any-Play, a paper I wrote with Ross Allen for AAMAS 2022.
        You can read the <a href="/files/anyplay.pdf">paper</a>, the
        <a id="kit-code-link" href="https://github.com/mit-ll/hanabi_AnyPlay">code</a>, a
        <a href="/files/anyplay_video.m4v">short video</a>, and the
        <a href="https://news.mit.edu/2022/is-diversity-key-to-collaboration-0525">article MIT wrote about it</a>.</p>
      <p>The reward for being recognisable is adapted from DIAYN (Eysenbach and
        colleagues, 2019), which learns a set of distinguishable behaviours with no
        score at all. Keeping the score is the change Any-Play makes, and it is the
        difference between six ways of winning and six ways of being unusual.</p>
      <p>Training a partner against a frozen cast of others comes from Fictitious
        Co-Play (Strouse and colleagues, 2021). Its cast comes from random seeds and
        saved checkpoints rather than from any objective that asks for variety, which is
        the gap Any-Play sets out to close.</p>
      <p>Other-Play and Off-Belief Learning (Hu, Lerer, Foerster and colleagues) take
        the opposite route, removing the arbitrary part so independently trained agents
        land in the same place. They do that well with their own kind. TrajeDi (Lupu and
        colleagues, 2021) pushes a population of policies apart with an explicit
        diversity term. The benchmark that made all of this measurable is the card game
        challenge of Bard and colleagues. The human study is Siu and colleagues, 2021.
        The failure where a diversity reward is satisfied by playing badly in a
        distinctive way is named in ADVERSITY (Cui and colleagues, 2023).</p>
      <p>The game, the art, the training code and everything running on this page are
        original.</p>
    </div>
  </div>
</div>

<style>
/* Full-screen takeover (rules only load on /keepittogether/). */
.page__title, .page__meta, .page__footer { display: none !important; }
.page__content { pointer-events: none; }
.kit-canvas, .kit-panel, .kit-actbar, .kit-fine, .kit-coach, .kit-recenter,
.kit-capcard, .kit-step { pointer-events: auto; }

.masthead { background: transparent !important; border-bottom: 0 !important; }
.greedy-nav { background: transparent !important; }
.kit-topfade {
  position: fixed; top: 0; left: 0; right: 0; height: 120px;
  z-index: 10; pointer-events: none;
  background: linear-gradient(to bottom,
    rgba(14,16,20,0.96) 0%, rgba(14,16,20,0.82) 32%, rgba(14,16,20,0) 100%);
}
html[data-theme="light"] .kit-topfade {
  background: linear-gradient(to bottom,
    rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-topfade {
    background: linear-gradient(to bottom,
      rgba(243,245,248,0.96) 0%, rgba(243,245,248,0.82) 32%, rgba(243,245,248,0) 100%);
  }
}

.kit-canvas {
  position: fixed; inset: 0; width: 100vw; height: 100vh; height: 100dvh;
  z-index: 0; background: transparent;
  touch-action: none;
}

.kit-panel {
  position: fixed; top: 4.6rem; right: 1rem; z-index: 30;
  width: 306px; max-width: calc(100vw - 2rem);
  /* Site standard. The chat widget is a fixed bar across the bottom right (a
     full-width bar on phones), so a panel that runs to within 2rem of the
     bottom edge ends with its last controls underneath it and unclickable. */
  max-height: calc(100vh - 10rem); max-height: calc(100dvh - 10rem);
  /* the head carries the panel's own top padding, because the head is sticky
     and a gap above it would show the body scrolling past (s7.24 ruling 4) */
  overflow: auto; padding: 0 1rem 1rem;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  /* Build spec v3 s7.24 ruling 1: OPAQUE. On a phone the expanded panel stands
     over the board, and at 0.94 the canvas HUD read straight through it as
     text under text (both ship-gate round 4 judges). The page also skips every
     canvas text run whose box falls inside this rect while the panel is open. */
  background: rgb(18,18,18);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-size: 0.92em;
}
/* Site standard, restored (build spec v3 s7.15 ruling 5; the audit's NIT 1
   found a dropped calc that capped the phone panel at 200px). */
@media (max-width: 768px) {
  .kit-panel { max-height: calc(100vh - 12.5rem); max-height: calc(100dvh - 12.5rem); }
  /* the tint is gone (ruling 1), so the blur under it can only cost a frame */
  .kit-panel { -webkit-backdrop-filter: none; backdrop-filter: none; }
}
html[data-theme="light"] .kit-panel { background: rgb(255,255,255); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-panel { background: rgb(255,255,255); border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15); }
}

/* The two blocks that never scroll: the head (title, "?", collapse) and the
   act row under it. They are sticky rather than lifted out of the scroll box so
   `.kit-panel` stays the element that scrolls (s7.22 ruling 2). Each one
   spreads to the scroll port's full width and paints its own opaque ground, or
   the body would run under them. */
.kit-panel__head, .kit-panel__pin {
  position: sticky; box-sizing: border-box;
  margin-left: -1rem; margin-right: -1rem;
  padding-left: 1rem; padding-right: 1rem;
  background: rgb(18,18,18);
}
html[data-theme="light"] .kit-panel__head,
html[data-theme="light"] .kit-panel__pin { background: rgb(255,255,255); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-panel__head,
  html:not([data-theme="dark"]) .kit-panel__pin { background: rgb(255,255,255); }
}
.kit-panel__head { top: 0; z-index: 4; padding-top: 0.85rem; padding-bottom: 0.45rem; }
/* `top` is written by the page from the head's measured height, so the two
   blocks stack instead of overlapping at any font size */
.kit-panel__pin { top: 2.6rem; z-index: 3; padding-bottom: 0.7rem; }
.kit-panel__pin .kit-lede { margin-bottom: 0.5rem; }
.kit-panel--collapsed .kit-panel__pin { display: none; }

/* Build spec v3 s7.19 ruling 3: the site's scroll fade cue. The panel is
   taller than its own window on a phone and the last line it showed was cut
   through the middle of a word, which reads as clipped text rather than as
   "there is more here". The page toggles kit-panel--more from the panel's own
   scroll position, exactly as the caption card and the act strip do. */
.kit-panel--more { box-shadow: 0 6px 24px rgba(0,0,0,0.35), inset 0 -17px 14px -14px rgba(0,0,0,0.85); }
html[data-theme="light"] .kit-panel--more { box-shadow: 0 6px 24px rgba(0,0,0,0.15), inset 0 -17px 14px -14px rgba(0,0,0,0.32); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-panel--more { box-shadow: 0 6px 24px rgba(0,0,0,0.15), inset 0 -17px 14px -14px rgba(0,0,0,0.32); }
}
/* and it cuts at a LINE: the body's own line height is the unit the last
   visible line is allowed to end on */
.kit-panel__body { padding-bottom: 0.35rem; }

.kit-panel__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
/* s7.32 addendum 3 item 5 (2026-10-10): where there is no phone act bar the sound toggle stands in this
   sticky head, beside "?", so it is reachable in every act; compact, so the head keeps one line */
.kit-panel__head .kit-sound--head { margin-left: auto; font-size: 0.7em; padding: 0.15rem 0.4rem; white-space: nowrap; line-height: 1.3; }
.kit-panel__head .kit-panel__title { white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.kit-panel__title { font-weight: 700; font-size: 1.05em; }
.kit-collapse {
  font: inherit; line-height: 1; cursor: pointer; color: inherit;
  width: 1.8em; height: 1.8em; padding: 0;
  flex: 0 0 auto;   /* a39: the landscape head squeezed it to 17 px */
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px; background: rgba(127,127,127,0.12);
}
.kit-panel--collapsed .kit-panel__body { display: none; }
/* a38: until keepittogether.js has wired the panel (seconds on a slow phone)
   its controls do nothing, so they are not offered: small screens show only
   the head, as the page will once it collapses the panel there, and larger
   ones show the panel dimmed and unpressable. The script removes data-boot
   and the static loading line once the game is live. */
.kit-panel[data-boot] > * { pointer-events: none; }
.kit-panel[data-boot] .kit-panel__pin, .kit-panel[data-boot] .kit-panel__body,
.kit-panel[data-boot] .kit-panel__head button { opacity: 0.5; }
@media (max-width: 599px), (max-height: 499px) {
  .kit-panel[data-boot] .kit-panel__pin, .kit-panel[data-boot] .kit-panel__body { display: none; }
}
/* B12 repair: until the theme's script has folded the masthead links into
   its menu (seconds on a slow phone), the link row is wider than a phone, and
   a mobile browser widens its layout viewport to fit it, which carried the
   fixed panel 33 px past the right edge. The masthead's sideways overflow is
   clipped on this page (clip, not hidden, so the menu still drops below). */
.masthead { overflow-x: clip; }
/* if keepittogether.js never runs, the loading line says so (the inline
   check after the scripts swaps its text) */
.kit-loading.kit-loading--failed { white-space: normal; width: max-content; }
.kit-loading {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  z-index: 35; margin: 0; pointer-events: none; text-align: center;
  max-width: calc(100vw - 2rem); white-space: nowrap;
  font-size: 1.05rem; line-height: 1.45;
  padding: 0.5rem 0.9rem; border-radius: 8px; border: 1px solid rgba(127,127,127,0.25);
  background: rgba(18,18,18,0.85); color: #d6d6d6; box-shadow: 0 6px 24px rgba(0,0,0,0.35);
}
html[data-theme="light"] .kit-loading { background: rgba(255,255,255,0.92); color: #3a3a3a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-loading { background: rgba(255,255,255,0.92); color: #3a3a3a; }
}
.kit-panel__body { display: flex; flex-direction: column; gap: 0.7rem; margin-top: 0.7rem; }

/* Controls first, prose after: the blurb and the credits are a dozen lines
   each, which is taller than the panel is ever allowed to be.
   The subtitle is prose too, and it rides with the act's prose rather than
   above the acts: it labels nothing, and the room it was taking at the top is
   what puts the two standing rows on screen in the your turn act (build spec
   v3 section 7.9 ruling 5). */
.kit-sub { order: 2; }
.kit-lede { order: 0; }
.kit-acts { order: 0; }
.kit-group { order: 0; }
.kit-row { order: 0; }
.kit-prose { order: 2; }
/* Build spec v3 s7.15 ruling 2: the status line sits BELOW the prose in a
   FIXED two-line slot, so a message that wraps can never push the prose (the
   audit measured 18 to 19 pure vertical jumps of #kit-actprose per three
   minutes, every one of them within 120 ms of a status resize). The slot is
   reserved whether or not there is a message in it. */
.kit-status-line { order: 3; }
.kit-blurb { order: 4; }
.kit-caveat { order: 5; }
.kit-verify-line { order: 6; }
.kit-credit { order: 7; }

/* the per-act prose the page writes */
.kit-prose { display: flex; flex-direction: column; gap: 0.5rem; }
.kit-prose:empty { display: none; }
.kit-prose p { margin: 0; font-size: 0.86em; opacity: 0.85; line-height: 1.45; }
.kit-prose p.kit-prose--note { font-size: 0.78em; opacity: 0.6; }

/* the partner picker. The theme styles select elements and washes them out,
   so both themes get explicit high-contrast colours (site gotcha 8). */
.kit-select {
  font: inherit; width: 100%; padding: 0.4em 0.5em; border-radius: 6px;
  border: 1px solid rgba(127,127,127,0.45);
  background: #1d1d1d; color: #e8e8e8;
}
html[data-theme="light"] .kit-select { background: #ffffff; color: #1c1c1c; border-color: rgba(0,0,0,0.25); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-select { background: #ffffff; color: #1c1c1c; border-color: rgba(0,0,0,0.25); }
}
.kit-select option { background: #1d1d1d; color: #e8e8e8; }
html[data-theme="light"] .kit-select option { background: #ffffff; color: #1c1c1c; }
/* the tray card: the renderer's own machine plate, so the icon and the world
   sprite cannot drift apart (SEAM R2-S1). It is drawn at 4 css pixels per
   source pixel, 104 x 136, because at the 1.5 css per sprite pixel the board
   runs at nobody could tell a machine from a crate (build spec v3 section 7.9
   ruling 3a, and SEAM R2f-S2 before it). */
.kit-tray { display: flex; gap: 0.5rem; align-items: flex-start; min-height: 0; flex: 0 0 auto; }
/* Build spec v3 s7.24 ruling 4: THE PORTRAIT SITS ABOVE THE TEXT. Beside a
   104 px portrait the blurb had a 138 px column inside a 306 px panel and set
   itself three words to a line, twelve ragged lines of it, which the dark
   ship-gate judge filed as a layout bug. The ruling's other branch (text
   >= 220 px) cannot be bought at this panel width, so the card stacks. It
   costs the group about 60 px of panel height, which is the trade the ruling
   makes and the reason the note about the old side-by-side is left above. */
.kit-partner__card { display: flex; flex-direction: column; gap: 0.5rem; align-items: stretch; }
.kit-partner__side { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; flex: 1 1 auto; }
/* .kit-row sets flex-wrap later in this sheet at the same specificity, so the
   one row that must not wrap says so with a class more than it has */
.kit-group .kit-row--pick { align-items: center; flex-wrap: nowrap; }
.kit-row--pick .kit-lede { flex: 0 0 auto; }
.kit-row--pick .kit-select { flex: 1 1 auto; min-width: 0; }
/* Build spec v3 s7.21 ruling 10. The theme's own _forms.scss puts a 1.5em
   bottom margin on every select and a margin under every label, which left
   about 33 css px of dead panel between the picker's heading and its dropdown
   and pushed the partner portrait down onto the panel's bottom edge, where the
   scroll fade cut it in half in the one act the picker is the point of. */
.kit-group .kit-select, .kit-group label { margin-bottom: 0; }
.kit-partner__card { scroll-margin-bottom: 0.6rem; }

/* the per partner ledger: neutral translucent values so one rule reads on both
   themes, and a table narrow enough for the 306px panel */
.kit-ledger table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
.kit-ledger th, .kit-ledger td {
  text-align: left; padding: 0.22em 0.3em; border-bottom: 1px solid rgba(127,127,127,0.28);
  vertical-align: top; line-height: 1.3;
}
.kit-ledger th { font-weight: 600; opacity: 0.75; }
.kit-ledger td.kit-ledger__n { text-align: right; font-variant-numeric: tabular-nums; }
.kit-ledger tr.kit-ledger__live td, .kit-ledger tr.kit-ledger__live th { font-weight: 700; }
.kit-ledger p { margin: 0; font-size: 0.82em; opacity: 0.62; line-height: 1.35; }
.kit-tray canvas { image-rendering: pixelated; }

/* Act 6, its own scrolling card */
.kit-fine {
  /* border-box or the padding and the border push the card 38px past the
     viewport at 390px and the page overflows sideways */
  box-sizing: border-box;
  position: fixed; z-index: 40; left: 50%; transform: translateX(-50%);
  top: 5.2rem; width: min(680px, calc(100vw - 2rem));
  max-height: calc(100vh - 11rem); max-height: calc(100dvh - 11rem);
  overflow: auto; padding: 0 1.1rem 1.1rem;
  border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
  background: rgba(18,18,18,0.975);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 8px 30px rgba(0,0,0,0.45); font-size: 0.94em; line-height: 1.55;
}
.kit-fine[hidden] { display: none !important; }
/* Build spec v3 s7.26 ruling 9: on a phone the site's two corner circles are
   fixed at the bottom left and they float OVER the dialog's last visible
   paragraph (the dark lane's ph-19-fine.png). While a dialog is open they
   stand down. Page-scoped, phone-only, and the owner may veto it: the same
   precedent the PDF Toolbench page set for its own toolbar. */
@media (max-width: 768px) {
  body.kit-modal-open #theme-toggle,
  body.kit-modal-open #life-link { display: none !important; }
}
html[data-theme="light"] .kit-fine { background: rgba(255,255,255,0.985); border-color: rgba(0,0,0,0.14); box-shadow: 0 8px 30px rgba(0,0,0,0.18); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-fine { background: rgba(255,255,255,0.985); border-color: rgba(0,0,0,0.14); box-shadow: 0 8px 30px rgba(0,0,0,0.18); }
}
/* Build spec v3 s7.19 ruling 10: the sticky header must not BLEED body text.
   `background: inherit` on a sticky child of a card whose own background is a
   translucent colour paints that translucency again, so a half line of the
   paragraph scrolling under it showed through (photographed by the light lane,
   22-header-bleed.png). The header carries the card's OPAQUE ground of its
   own, in both themes, and a hairline under it so the join reads as deliberate. */
.kit-fine__head {
  position: sticky; top: 0; z-index: 1;
  display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
  padding: 0.8rem 0 0.6rem;
  background: #121212;
  border-bottom: 1px solid rgba(127,127,127,0.25);
}
html[data-theme="light"] .kit-fine__head { background: #ffffff; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-fine__head { background: #ffffff; }
}
.kit-fine__title { margin: 0; font-size: 1.12em; }
.kit-fine__body > * { margin-top: 0.9rem; }
.kit-fine p { margin: 0 0 0.6rem; }
/* ruling 10: "Did the AI name the plans?" and "Credits" were cramped together */
.kit-fine h3 { margin: 1.15rem 0 0.5rem; font-size: 1em; }
.kit-fine h3:first-child { margin-top: 0; }
.kit-fine summary { cursor: pointer; font-weight: 600; }
.kit-fine table { width: 100%; border-collapse: collapse; margin: 0 0 0.7rem; font-size: 0.92em; }
.kit-fine th, .kit-fine td { text-align: left; padding: 0.3em 0.45em; border-bottom: 1px solid rgba(127,127,127,0.28); vertical-align: top; }
.kit-fine td { text-align: right; font-variant-numeric: tabular-nums; }
.kit-papercard, .kit-strip, .kit-siu {
  border: 1px solid rgba(127,127,127,0.35); border-radius: 8px; padding: 0.8rem 0.9rem 0.3rem;
}
@media (max-width: 700px) {
  .kit-fine { top: 4.2rem; max-height: calc(100dvh - 9rem); font-size: 0.92em; }
}
/* s7.29 ruling 4: the reduced-motion line. The theme styles paragraphs, so
   the hidden attribute is spelled out here the way every other panel on this
   page spells it (the PDF page's precedent). */
.kit-help__rm { margin: 0 0 0.7rem; padding: 0.5rem 0.65rem;
  border-left: 3px solid rgba(127, 127, 127, 0.55);
  background: rgba(127, 127, 127, 0.12); border-radius: 3px; }
.kit-help__rm[hidden] { display: none !important; }
.kit-helpcard ul { margin: 0 0 0.6rem; padding-left: 1.15rem; }
.kit-helpcard li { margin: 0 0 0.35rem; }

/* ---------------------------------------------------- the walkthrough strip
   Build spec v3 s7.15 ruling 1. Fixed, page-owned, and placed by layout()
   into a band the board is not allowed to use, so "never overlaps the board,
   a modal or the panel" is a property of the layout rather than a placement
   negotiation that can fail. */
.kit-coach {
  position: fixed; z-index: 35; box-sizing: border-box;
  padding: 0.6rem 2.2rem 0.6rem 0.95rem;
  border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
  background: rgba(18,18,18,0.94); color: #d6d6d6;
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35);
  font-size: 0.92em; line-height: 1.45; pointer-events: auto;
}
.kit-coach[hidden] { display: none !important; }
html[data-theme="light"] .kit-coach {
  background: rgba(255,255,255,0.97); color: #262626;
  border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-coach {
    background: rgba(255,255,255,0.97); color: #262626;
    border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 24px rgba(0,0,0,0.15);
  }
}
.kit-coach__text { margin: 0 0 0.5rem; }
.kit-coach__row { display: flex; align-items: center; gap: 0.5rem; }
.kit-coach__dots { display: flex; gap: 6px; margin-right: auto; align-items: center; }
.kit-coach__dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(127,127,127,0.45); }
.kit-coach__dot--on { background: #82a6cc; }
html[data-theme="light"] .kit-coach__dot--on { background: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-coach__dot--on { background: #34568a; }
}
.kit-coach__next { border-color: #82a6cc; background: rgba(130,166,204,0.16); text-align: center; }
html[data-theme="light"] .kit-coach__next { border-color: #34568a; background: rgba(52,86,138,0.12); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-coach__next { border-color: #34568a; background: rgba(52,86,138,0.12); }
}
.kit-coach__x {
  position: absolute; top: 0.2rem; right: 0.3rem; width: 1.9em; height: 1.9em;
  font: inherit; line-height: 1; color: inherit; background: none; border: 0;
  padding: 0; cursor: pointer; opacity: 0.55;
}
.kit-coach__x:hover, .kit-coach__x:focus { opacity: 1; }
@media (pointer: coarse) { .kit-coach__x { min-width: 36px; min-height: 36px; } }

/* ------------------------------------------------- the phone caption card
   Build spec v3 s7.17 ruling 2. The panel auto-collapses under 600px and
   takes the act's own sentences and the status line with it, and at a real
   phone's pixel ratio the whole board is 178 css px tall, so the page was
   left with 171px of empty room under it on the landing and in Reading the
   plan. The card puts that text back, in that room. The page writes its box
   from the frame's own slot plan, so it can never stand on the board. */
/* Every line in here is EXACTLY 18px tall and the padding is 9px, because the
   page counts the lines a card really shows (CARD_LINE / CARD_PAD / the 1px
   border in keepittogether.js) and writes a taller padding-TOP for the
   remainder, so the last line before anyone scrolls is always a whole one. A
   card sized to whatever the room had left over ends on half a line, which
   reads as a bug rather than as a card with more in it. Change either number
   here and change it there. */
.kit-capcard {
  position: fixed; z-index: 29; box-sizing: border-box;
  /* Build spec v3 s7.24 ruling 4: the card CUTS AT A SENTENCE, never mid
     sentence behind a hairline scrollbar ("...your partner puts up gold", both
     round 4 judges). The page trims whole sentences off the end until the text
     fits the room the slot plan gave it and marks the card with the site fade
     cue, so there is nothing left to scroll to and no scrollbar to promise it.
     The full prose is in the panel, one tap away. */
  overflow: hidden;
  /* the card fills the room it was given, so a short act would otherwise leave
     its text stranded at the top of a tall empty box. `safe` centring puts a
     block that FITS in the middle and falls back to the start the moment it
     does not, which is the one case where the top must stay reachable. The
     fallback below is start alignment for anything that does not know it. */
  display: flex; flex-direction: column; justify-content: flex-start;
  padding: 9px 11px;
  border: 1px solid rgba(255,255,255,0.12); border-radius: 10px;
  background: rgba(18,18,18,0.92);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  font-size: 13px; line-height: 18px;
}
@supports (justify-content: safe center) {
  .kit-capcard { justify-content: safe center; }
}
.kit-capcard[hidden] { display: none !important; }
/* Build spec v3 s7.19 ruling 4: the card FADES rather than vanishing mid
   sentence when the follow camera takes the room. The page removes the class
   again after the transition, so nothing here is a state the card can get
   stuck in. Reduced motion never adds the class at all. */
.kit-capcard { transition: opacity 0.22s ease; }
.kit-capcard--out { opacity: 0; pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  .kit-capcard { transition: none; }
}
/* the site's scroll cue: a card with more text under its last line says so */
.kit-capcard--more { box-shadow: inset 0 -15px 13px -13px rgba(0,0,0,0.75); }
html[data-theme="light"] .kit-capcard {
  background: rgba(255,255,255,0.95); border-color: rgba(0,0,0,0.12);
}
html[data-theme="light"] .kit-capcard--more {
  box-shadow: inset 0 -15px 13px -13px rgba(0,0,0,0.30);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-capcard {
    background: rgba(255,255,255,0.95); border-color: rgba(0,0,0,0.12);
  }
  html:not([data-theme="dark"]) .kit-capcard--more {
    box-shadow: inset 0 -15px 13px -13px rgba(0,0,0,0.30);
  }
}
.kit-capcard p { margin: 0; font-size: 13px; line-height: 18px; }
/* a flex item that may not be squeezed: the card scrolls instead */
.kit-capcard__status, .kit-capcard__prose { flex: 0 0 auto; }
.kit-capcard__status { opacity: 0.95; }
.kit-capcard__status:empty { display: none; }
.kit-capcard__status:not(:empty) + .kit-capcard__prose { margin-top: 18px; }
.kit-capcard__prose p { opacity: 0.8; }
.kit-capcard__prose p + p { margin-top: 18px; }
.kit-capcard__prose p.kit-prose--note { font-size: 12px; opacity: 0.6; }

/* the recenter button beside the phone overview inset */
.kit-recenter {
  position: fixed; z-index: 31; font: inherit; line-height: 1; cursor: pointer;
  color: inherit; padding: 0.42em 0.6em; border-radius: 6px;
  border: 1px solid rgba(127,127,127,0.5); background: rgba(18,18,18,0.86);
  font-size: 0.8em;
}
.kit-recenter[hidden] { display: none !important; }
html[data-theme="light"] .kit-recenter { background: rgba(255,255,255,0.92); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-recenter { background: rgba(255,255,255,0.92); }
}
@media (pointer: coarse) { .kit-recenter { min-height: 36px; } }
/* the reduced-motion Step control (build spec v3 s7.19 ruling 6). It shares
   the recenter button's chrome because it is the same kind of thing: a small
   control the page places against the board it acts on. */
.kit-step { z-index: 31; font-weight: 600; }
.kit-step[hidden] { display: none !important; }

.kit-sub { margin: 0; font-size: 0.95em; opacity: 0.8; }
.kit-lede { margin: 0; font-size: 0.85em; opacity: 0.7; }
.kit-hint { margin: 0; font-size: 0.82em; opacity: 0.62; line-height: 1.35; }
/* Two columns, not six stacked rows: the single column was 204 px tall in a
   panel window of about 719 px at 1440x900, and it was what pushed the per
   partner ledger below the fold (build spec v3 section 7.8 ruling 4b). */
.kit-acts { display: grid; grid-template-columns: 1fr 1fr; gap: 0.3rem; }
.kit-acts .kit-act { text-align: center; }
.kit-group { display: flex; flex-direction: column; gap: 0.4rem; }
.kit-row { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.kit-btn {
  font: inherit; color: inherit; cursor: pointer; line-height: 1;
  border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.14);
  border-radius: 6px; padding: 0.45em 0.7em; transition: background 0.15s ease;
  text-align: left;
}
.kit-btn:hover { background: rgba(127,127,127,0.26); }
.kit-btn--wide { width: 100%; text-align: center; }
.kit-seg { flex: 1; text-align: center; }
.kit-seg--on, .kit-act--on { border-color: #82a6cc; background: rgba(130,166,204,0.18); }
.kit-check { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.92em; cursor: pointer; }
.kit-check input { accent-color: #82a6cc; }
/* The fixed two-line slot. Height is set, not min-set: a three-line message
   would move the panel, so the span clamps to two lines and the full sentence
   goes to the screen reader mirror instead of being cut mid word. */
.kit-status-line {
  margin: 0; font-size: 0.9em; opacity: 0.85;
  height: 2.7em; line-height: 1.35; overflow: hidden;
}
.kit-status-line > span {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
/* The budget readout, beside the build buttons and never below the fold
   (build spec v3 s7.15 ruling 2). */
.kit-budget {
  margin: 0; font-size: 0.95em; font-weight: 600;
  display: flex; align-items: baseline; gap: 0.4rem;
}
.kit-budget[hidden] { display: none !important; }
.kit-budget__n { font-variant-numeric: tabular-nums; font-size: 1.15em; }
.kit-budget--low .kit-budget__n { color: #c4574a; }
/* s7.26 ruling 2: during Your turn the line is moved into the pinned block,
   where no scroll can cover it. It keeps the same ink and sits on the act
   row's own top margin. */
.kit-budget--pinned { margin-top: 0.5rem; }
/* s7.27 ruling 1 (SEAM I1R-S1): during Your turn the whole build row joins the
   pinned block, under the budget line, because the reveal of the partner
   portrait and this row could not both fit in the window the pin leaves at
   window heights 720 to 1000, and the row was the one that lost. It is a block
   child of the pin rather than a flex item of the body there, so it carries
   the gap the body's `gap` used to give it. The page's own BUILD_PIN_GAP is
   this number. */
.kit-panel__pin .kit-group--pinned { margin-top: 0.5rem; }
/* The budget line asks for `margin: 0` above and does not get it: the theme's
   own `.page__content p { margin: 0 0 1.3em }` is one specificity point
   heavier than `.kit-budget`, so the readout carries 21.5 px of dead space
   under it that the panel's flex `gap` then adds to. In the flow that is only
   loose; in the PINNED block it is 21.5 px taken out of the window the partner
   reveal has to fit the portrait and its blurb into, and at 1440x900 that is
   the difference between the two fitting (335.7 px of block in 348.2 px of
   window) and the reveal clamping. Scoped to the pinned row, so no other
   paragraph in the panel moves. */
.kit-panel__pin .kit-group--pinned .kit-budget { margin-bottom: 0; }
#kit-bar-budget {
  flex: 0 0 auto; text-align: center; white-space: nowrap;
  border: 1px solid rgba(127,127,127,0.4); border-radius: 6px;
  background: rgba(127,127,127,0.14); padding: 0.45em 0.6em; line-height: 1;
  font-variant-numeric: tabular-nums;
}
/* s7.26 ruling 7: an empty chip is still a grey box the size of a button */
#kit-bar-budget[hidden] { display: none !important; }
.kit-btn[disabled] { opacity: 0.42; cursor: default; }
.kit-btn[disabled]:hover { background: rgba(127,127,127,0.14); }
.kit-blurb { margin: 0; font-size: 0.88em; opacity: 0.85; line-height: 1.5; }
.kit-caveat { margin: 0; font-size: max(12px, 0.8em); opacity: 0.6; line-height: 1.45; }
.kit-verify-line { margin: 0; font-size: max(12px, 0.78em); opacity: 0.6; line-height: 1.4; }
.kit-credit { margin: 0; font-size: max(12px, 0.78em); opacity: 0.55; line-height: 1.4; }
/* a41: in light mode the opacity dimming left these lines at 3.5 to 4.1:1 on
   the white panel; a solid muted grey reads about 5:1 (dark passes as it is) */
html[data-theme="light"] .kit-caveat, html[data-theme="light"] .kit-verify-line,
html[data-theme="light"] .kit-credit { opacity: 1; color: #6b6b6b; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-caveat, html:not([data-theme="dark"]) .kit-verify-line,
  html:not([data-theme="dark"]) .kit-credit { opacity: 1; color: #6b6b6b; }
}
.kit-sr {
  position: absolute; width: 1px; height: 1px; margin: -1px;
  padding: 0; border: 0; overflow: hidden; white-space: nowrap;
  clip: rect(0 0 0 0); clip-path: inset(50%);
}

/* The phone act bar, created by the page under 600px. */
/* ruling 3: while the panel is expanded the bar stands down, so the phone
   never carries two of everything */
.kit-actbar[hidden] { display: none !important; }
.kit-actbar {
  position: fixed; left: 0; right: 0; z-index: 30;
  display: flex; flex-direction: column; gap: 0.35rem; padding: 0.4rem 0.5rem;
  background: rgba(18,18,18,0.92);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  border-top: 1px solid rgba(255,255,255,0.10);
}
html[data-theme="light"] .kit-actbar { background: rgba(255,255,255,0.95); border-top-color: rgba(0,0,0,0.10); }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-actbar { background: rgba(255,255,255,0.95); border-top-color: rgba(0,0,0,0.10); }
}
/* Two rows: the acts, and (in Your turn only) the build controls. The panel
   auto-collapses under 600px, so a primary action that lived only in it would
   be one the visitor has to go looking for. */
.kit-actbar__row {
  display: flex; gap: 0.35rem;
  overflow-x: auto; -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.kit-actbar__row::-webkit-scrollbar { display: none; }
/* Build spec v3 s7.16 ruling 5. At 390x844 the whole-board phone view is a
   fixed 356 css px tall (the renderer's ladder floors at one source pixel per
   device pixel), and the layout was left with about 105 px of empty page
   between the board caption and this strip. Raising the strip only moves that
   hole below it, because the site corner buttons own the bottom of the screen,
   so the strip fills the room instead and every act becomes reachable without
   scrolling. The page adds this class only while the extra rows cost the board
   no height; where they would, the row stays a scroller with its fade and its
   arrow. */
.kit-actbar__row--wrap { flex-wrap: wrap; overflow-x: visible; }
/* Build spec v3 s7.15 ruling 5: three of the six acts started off screen in a
   754px row inside a 374px window with no affordance at all (mobile Chrome
   hides the scrollbar), so the strip says it scrolls. The fade and the arrow
   are added by the page only while the row really overflows. */
.kit-actbar__wrap { position: relative; }
.kit-actbar__fade {
  position: absolute; top: 0; bottom: 0; right: 0; width: 3.2rem;
  pointer-events: none; opacity: 0; transition: opacity 0.18s ease;
  background: linear-gradient(to right, rgba(18,18,18,0) 0%, rgba(18,18,18,0.92) 74%);
}
.kit-actbar__wrap--more .kit-actbar__fade { opacity: 1; }
html[data-theme="light"] .kit-actbar__fade {
  background: linear-gradient(to right, rgba(255,255,255,0) 0%, rgba(255,255,255,0.95) 74%);
}
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-actbar__fade {
    background: linear-gradient(to right, rgba(255,255,255,0) 0%, rgba(255,255,255,0.95) 74%);
  }
}
.kit-actbar__arrow {
  position: absolute; top: 50%; right: 0.1rem; transform: translateY(-50%);
  display: none; font: inherit; line-height: 1; color: inherit; cursor: pointer;
  min-width: 32px; min-height: 32px; padding: 0;
  border: 1px solid rgba(127,127,127,0.5); border-radius: 6px;
  background: rgba(127,127,127,0.22);
}
.kit-actbar__wrap--more .kit-actbar__arrow { display: block; }
/* Build spec v3 s7.19 ruling 3: the chevron NEVER paints over a label. It sat
   on top of the next button's text and printed "Stra>" over Strangers (the
   light lane's 41-phone-arrow-overlap.png). While the arrow is shown the row
   reserves its width at the end of its own scrolling content, so the last
   label always ends before the chevron starts. */
.kit-actbar__wrap--more .kit-actbar__row { padding-right: 2.9rem; }
@media (prefers-reduced-motion: reduce) {
  .kit-actbar__fade { transition: none; }
}
.kit-actbar .kit-btn {
  white-space: nowrap; flex: 0 0 auto;
  /* the bar is only ever built under 600px, so the phone touch target is the
     right size here whatever the pointer media query says */
  min-height: 40px;
}
#kit-actbar-build .kit-btn { flex: 1 1 auto; text-align: center; }
/* Build spec v3 s7.24 ruling 2: the build row NEVER CLIPS AND NEVER SCROLLS
   OFF. At 390 px "Undo" sat at 330 to 396 with the document's scrollWidth equal
   to the viewport, so the cut part was unreachable, and both ship-gate round 4
   judges called the row broken. It wraps instead: four whole, tappable buttons
   on as many rows as the width needs, and the strip's own height is measured
   after the wrap (layout() reads the bar's rect), so the board keeps its room.
   The acts row above it keeps its scroller and its affordance. */
#kit-actbar-build { flex-wrap: wrap; overflow-x: visible; }
#kit-actbar-build .kit-btn { min-width: 5.6rem; }

@media (pointer: coarse) {
  .kit-btn { min-height: 40px; padding: 0.5em 0.85em; }
  .kit-seg { min-height: 44px; }
  /* a119: the older gadgets' touch sizes (36x40 collapse, 40x40 help) */
  .kit-collapse { width: 2.3em; height: 2.3em; min-width: 36px; min-height: 40px; }
  .kit-panel .gadget-help { min-width: 40px; min-height: 40px; }
  .kit-check input { width: 20px; height: 20px; }
}

html[data-theme="light"] .kit-seg--on,
html[data-theme="light"] .kit-act--on { border-color: #34568a; background: rgba(52,86,138,0.14); }
html[data-theme="light"] .kit-check input { accent-color: #34568a; }
@media (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) .kit-seg--on,
  html:not([data-theme="dark"]) .kit-act--on { border-color: #34568a; background: rgba(52,86,138,0.14); }
  html:not([data-theme="dark"]) .kit-check input { accent-color: #34568a; }
}
</style>

<script defer src="{{ '/assets/js/gadget-ui.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/share-hash.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/keepittogether-core.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/keepittogether-model.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/keepittogether-render.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/keepittogether-audio.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<script defer src="{{ '/assets/js/keepittogether.js' | relative_url }}?v={{ site.time | date: '%s' }}"></script>
<noscript><style>#kit-loading { display: none; }</style><p class="kit-loading kit-loading--failed">This game needs JavaScript, which is turned off in this browser.</p></noscript>
<script>
/* B12 repair: keepittogether.js removes data-boot when the game is live. If it
   failed to load or threw before that, the load event finds data-boot still
   set, and the static loading line says what happened instead of spinning. */
window.addEventListener('load', function () {
  setTimeout(function () {
    var panel = document.getElementById('kit-panel');
    var ld = document.getElementById('kit-loading');
    if (!panel || !ld || !panel.hasAttribute('data-boot')) return;
    ld.className += ' kit-loading--failed';
    ld.textContent = 'The game did not load. Reload the page to try again.';
  }, 0);
});
</script>
