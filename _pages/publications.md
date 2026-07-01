---
layout: archive
title: "Publications"
permalink: /publications/
author_profile: true
---

{% if author.googlescholar %}
  You can also find my articles on <u><a href="{{author.googlescholar}}">my Google Scholar profile</a>.</u>
{% endif %}

{% include base_path %}

## Technical Reports & Industry Writing

Not peer-reviewed; published on [Anthropic's Frontier Red Team blog](https://red.anthropic.com/), where we post our work measuring, projecting, and improving frontier LLM capabilities.

<div class="report-list">

  <div class="report">
    <a class="report__fig" href="https://red.anthropic.com/2026/n-days/"><img src="{{ base_path }}/images/pub-figures/n-days.png" alt="" loading="lazy"></a>
    <div class="report__body">
      <a href="https://red.anthropic.com/2026/n-days/"><b>Measuring LLMs' Impact on N-day Exploits</b></a> <span class="report__year">2026</span>
      <p>How well frontier models can develop exploits for publicly disclosed but unpatched vulnerabilities.</p>
    </div>
  </div>

  <div class="report">
    <a class="report__fig" href="https://red.anthropic.com/2026/exploit-evals/"><img src="{{ base_path }}/images/pub-figures/exploit-evals.png" alt="" loading="lazy"></a>
    <div class="report__body">
      <a href="https://red.anthropic.com/2026/exploit-evals/"><b>Measuring LLMs' Ability to Develop Exploits</b></a> <span class="report__year">2026</span>
      <p>Benchmarks (ExploitBench, ExploitGym, SCONE-bench) for measuring how well frontier models build end-to-end software and smart-contract exploits.</p>
    </div>
  </div>

  <div class="report">
    <a class="report__fig" href="https://red.anthropic.com/2026/mythos-preview/"><img src="{{ base_path }}/images/pub-figures/mythos-preview.png" alt="" loading="lazy"></a>
    <div class="report__body">
      <a href="https://red.anthropic.com/2026/mythos-preview/"><b>Assessing Claude Mythos Preview's Cybersecurity Capabilities</b></a> <span class="report__year">2026</span>
      <p>Evaluating a frontier model's ability to autonomously discover and exploit zero-day and N-day vulnerabilities across operating systems, browsers, and libraries.</p>
    </div>
  </div>

  <div class="report">
    <a class="report__fig" href="https://red.anthropic.com/2026/firefox/"><img src="{{ base_path }}/images/pub-figures/firefox.png" alt="" loading="lazy"></a>
    <div class="report__body">
      <a href="https://red.anthropic.com/2026/firefox/"><b>Partnering with Mozilla to Improve Firefox's Security</b></a> <span class="report__year">2026</span>
      <p>A collaboration with Mozilla in which Claude Opus 4.6 found 22 vulnerabilities in Firefox.</p>
    </div>
  </div>

  <div class="report">
    <div class="report__body">
      <a href="https://red.anthropic.com/2026/exploit/"><b>Reverse Engineering Claude's CVE-2026-2796 Exploit</b></a> <span class="report__year">2026</span>
      <p>A technical deep dive into an exploit Claude developed for a Firefox vulnerability.</p>
    </div>
  </div>

  <div class="report">
    <div class="report__body">
      <a href="https://red.anthropic.com/2026/zero-days/"><b>LLM-discovered 0-days</b></a> <span class="report__year">2026</span>
      <p>Claude found 500+ high-severity vulnerabilities in open-source projects.</p>
    </div>
  </div>

  <div class="report">
    <div class="report__body">
      <a href="https://red.anthropic.com/2026/cyber-toolkits-update/"><b>AI Models on Realistic Cyber Ranges</b></a> <span class="report__year">2026</span>
      <p>Claude succeeds at multistage network attacks using only standard tools.</p>
    </div>
  </div>

  <div class="report">
    <div class="report__body">
      <a href="https://red.anthropic.com/2026/critical-infrastructure-defense/"><b>AI to Defend Critical Infrastructure</b></a> <span class="report__year">2026</span>
      <p>Partnership with PNNL exploring AI-accelerated defense.</p>
    </div>
  </div>

  <div class="report">
    <div class="report__body">
      <a href="https://red.anthropic.com/2025/ai-for-cyber-defenders/"><b>AI for Cyber Defenders</b></a> <span class="report__year">2025</span>
      <p>Building defensive cybersecurity capabilities.</p>
    </div>
  </div>

  <div class="report">
    <div class="report__body">
      <a href="https://red.anthropic.com/2025/cyber-competitions/"><b>Claude in Cyber Competitions</b></a> <span class="report__year">2025</span>
      <p>Evaluating Claude's performance in CTF competitions (the subject of my <a href="{{ base_path }}/talks/2025-08-09-claude-climbing-a-ctf-scoreboard-near-you">DEF CON talk</a>).</p>
    </div>
  </div>

  <div class="report">
    <div class="report__body">
      <a href="https://red.anthropic.com/2025/cyber-toolkits/"><b>Cyber Toolkits</b></a> <span class="report__year">2025</span>
      <p>A collaboration with <a href="https://www.brianhacks.com/">Brian Singer</a> on measuring LLMs' network attack capabilities (related to the Incalmo paper below).</p>
    </div>
  </div>

</div>

<style>
.report-list { margin: 1em 0 2.5em; display: flex; flex-direction: column; gap: 1.1em; }
.report { display: flex; gap: 1em; align-items: flex-start; }
.report__fig { flex: 0 0 150px; line-height: 0; }
.report__fig img {
  width: 150px; height: auto; border-radius: 6px;
  border: 1px solid rgba(127,127,127,0.28);
}
.report__body { flex: 1; min-width: 0; }
.report__body p { margin: 0.2em 0 0; opacity: 0.85; font-size: 0.95em; }
.report__year { opacity: 0.6; font-size: 0.9em; margin-left: 0.2em; }
@media (max-width: 520px) {
  .report { flex-direction: column; gap: 0.5em; }
  .report__fig, .report__fig img { width: 100%; flex-basis: auto; }
}
</style>

## Peer-Reviewed Publications

{% for post in site.publications reversed %}
  {% include archive-single.html %}
{% endfor %}
