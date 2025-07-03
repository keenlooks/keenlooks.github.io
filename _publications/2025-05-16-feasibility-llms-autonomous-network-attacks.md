---
title: "(arXiv) On the Feasibility of Using LLMs to Autonomously Execute Multi-host Network Attacks"
collection: publications
permalink: /publications/2025-05-16-feasibility-llms-autonomous-network-attacks
redirect_from: 
  - /incalmo/
  - /feasibility-llms-autonomous-network-attacks/
date: 2025-05-16
venue_short: "arXiv"
venue: "arXiv preprint"
type: "Publication"
excerpt: ""
authors_short: "B. Singer, <u>K. Lucas</u>, L. Adiga, M. Jain, L. Bauer, and V. Sekar"
authors: "Brian Singer, <u>Keane Lucas</u>, Lakshmi Adiga, Meghna Jain, Lujo Bauer, and Vyas Sekar"
citation: "Brian Singer, Keane Lucas, Lakshmi Adiga, Meghna Jain, Lujo Bauer, and Vyas Sekar. On the Feasibility of Using LLMs to Autonomously Execute Multi-host Network Attacks. arXiv preprint"
paperurl: 'https://arxiv.org/pdf/2501.16466'
bibtex: /files/incalmo.bib
---

LLMs have shown preliminary promise in some security tasks and CTF challenges. Real cyberattacks are often multi-host network attacks, which involve executing a number of steps across multiple hosts such as conducting reconnaissance, exploiting vulnerabilities, and using compromised hosts to exfiltrate data. To date, the extent to which LLMs can autonomously execute multi-host network attacks is not well understood. To this end, our first contribution is MHBench, an open-source multi-host attack benchmark with 10 realistic emulated networks (from 25 to 50 hosts). We find that popular LLMs including modern reasoning models (e.g., GPT4o, Gemini 2.5 Pro, Sonnet 3.7 Thinking) with state-of-art security-relevant prompting strategies (e.g., PentestGPT, CyberSecEval3) cannot autonomously execute multi-host network attacks. To enable LLMs to autonomously execute such attacks, our second contribution is Incalmo, an high-level abstraction layer. Incalmo enables LLMs to specify high-level actions (e.g., infect a host, scan a network). Incalmo's translation layer converts these actions into lower-level primitives (e.g., commands to exploit tools) through expert agents. In 9 out of 10 networks in MHBench, LLMs using Incalmo achieve at least some of the attack goals. Even smaller LLMs (e.g., Haiku 3.5, Gemini 2 Flash) equipped with Incalmo achieve all goals in 5 of 10 environments. We also validate the key role of high-level actions in Incalmo's abstraction in enabling LLMs to autonomously execute such attacks.

Please check out the [paper](https://arxiv.org/pdf/2501.16466) and [code](https://github.com/bsinger98/Incalmo)!