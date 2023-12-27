---
title: "Conference Presentation: Any-Play: an Intrinsic Augmentation for Zero-Shot Coordination"
collection: talks
permalink: /talks/2022-05-11-anyplay-an-intrinsic-augmentation-for-zero-shot-coordination
date: 2022-05-11
venue_short: "AAMAS '22"
venue: "International Conference on Autonomous Agents and Multi-Agent Systems 2022"
type: "Presentation"
excerpt: ""
authors_short: "<u>K. Lucas</u>, R. Allen"
authors: "<u>Keane Lucas</u>, Ross E. Allen"
citation: "Keane Lucas, Ross E. Allen. Any-Play: an Intrinsic Augmentation for Zero-Shot Coordination. AAMAS'22."
paperurl: '/files/anyplay.pdf'
bibtex: /files/anyplay.bib
---

Cooperative artificial intelligence with human or superhuman proficiency in collaborative tasks stands at the frontier of machine learning research. Prior work has tended to evaluate cooperative AI performance under the restrictive paradigms of *self-play* (teams composed of agents trained together) and *cross-play* (teams of agents trained independently but using the same algorithm). Recent work has indicated that AI optimized for these narrow settings may make for undesirable collaborators in the real-world. We formalize an alternative criteria for evaluating cooperative AI, referred to as *inter-algorithm cross-play*, where agents are evaluated on teaming performance with all other agents within an experiment pool with no assumption of algorithmic similarities between agents. We show that existing state-of-the-art cooperative AI algorithms, such as Other-Play and Off-Belief Learning, under-perform in this paradigm. We propose the *Any-Play* learning augmentation---a multi-agent extension of diversity-based intrinsic rewards for zero-shot coordination (ZSC)---for generalizing self-play-based algorithms to the inter-algorithm cross-play setting. We apply the Any-Play learning augmentation to the Simplified Action Decoder (SAD) and demonstrate state-of-the-art performance in the collaborative card game Hanabi.

This project is the result of a summer 2021 internship at [MIT Lincoln Lab](https://www.ll.mit.edu/) as part of their [AI Technology Group](https://www.ll.mit.edu/r-d/technology-office/artificial-intelligence-technology).

Please check out the [paper](/files/anyplay.pdf), [code](https://github.com/mit-ll/hanabi_AnyPlay), [video](/files/anyplay_video.m4v), and a [news article](https://news.mit.edu/2022/is-diversity-key-to-collaboration-0525) MIT wrote about it!
