---
title: "Incalmo: An Autonomous LLM-assisted System for Red Teaming Multi-Host Networks"
collection: publications
permalink: /publications/2025-05-16-feasibility-llms-autonomous-network-attacks
redirect_from: 
  - /incalmo/
  - /feasibility-llms-autonomous-network-attacks/
date: 2026-05-18
venue_short: "IEEE S&P '26"
venue: "IEEE Symposium on Security and Privacy (S&P) 2026"
type: "Publication"
excerpt: ""
authors_short: "B. Singer, <u>K. Lucas</u>, L. Adiga, M. Jain, L. Bauer, and V. Sekar"
authors: "Brian Singer, <u>Keane Lucas</u>, Lakshmi Adiga, Meghna Jain, Lujo Bauer, and Vyas Sekar"
citation: "Brian Singer, Keane Lucas, Lakshmi Adiga, Meghna Jain, Lujo Bauer, and Vyas Sekar. Incalmo: An autonomous LLM-assisted system for red teaming multi-host networks. In Proceedings of the 47th IEEE Symposium on Security and Privacy, May 2026."
paperurl: '/files/sp2026-incalmo.pdf'
bibtex: /files/incalmo.bib
---

In realistic enterprise settings, red teaming involves executing multi-host network attacks that span many "stepping stone" hosts, but red teams are expensive and entail significant expertise and effort. To date, the extent to which LLMs can autonomously execute such attacks is not well understood. We find that state-of-the-art LLM-assisted offense systems (e.g., PentestGPT, CyberSecEval3) with leading LLMs cannot autonomously execute multi-host network attacks. To enable them to, we built Incalmo, a high-level attack-abstraction layer: instead of having LLMs interact with low-level tools and commands, Incalmo lets LLMs plan red team exercises in terms of high-level declarative tasks (e.g., infect a host, scan a network) that are executed by domain-specific task agents, with auxiliary services to manage context and acquired assets. To evaluate it, we built MHBench, a multi-host attack benchmark of realistic emulated networks (from 22 to 50 hosts). Incalmo successfully acquires critical assets in 37 out of 40 MHBench environments, whereas state-of-the-art LLM-assisted systems succeed in only 3 out of 40.

Please check out the [paper](/files/sp2026-incalmo.pdf) and [code](https://github.com/bsinger98/Incalmo)!
