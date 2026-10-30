---
title: "Group-based Robustness: A General Framework for Customized Robustness in the Real World"
collection: publications
permalink: /publications/2024-02-26-group-based-robustness
redirect_from: 
  - /groupbased/
  - /group-based/
  - /gbr/
  - /GBR/
date: 2024-02-26
venue_short: "NDSS '24"
venue: "Network and Distributed System Security Symposium"
type: "Publication"
excerpt: ""
authors_short: "W. Lin, <u>K. Lucas</u>, N. Eyal, L. Bauer, M. K. Reiter, and M. Sharif"
authors: "Weiran Lin, <u>Keane Lucas</u>, Neo Eyal, Lujo Bauer, Michael K. Reiter, Mahmood Sharif"
citation: "Weiran Lin, Keane Lucas, Neo Eyal, Lujo Bauer, Michael K. Reiter, Mahmood Sharif. Group-based Robustness: A General Framework for Customized Robustness in the Real World. In Proc. NDSS '24."
paperurl: 'https://www.ndss-symposium.org/wp-content/uploads/2024-84-paper.pdf'
bibtex: /files/group-based-robustness.bib
description: "Group-based robustness, a metric for attacks from one set of classes to another, with new losses and attack strategies that save up to 99% of search time."
---

Machine-learning models are known to be vulnerable to evasion attacks that perturb model inputs to induce misclassifications. In this work, we identify real-world scenarios where the true threat cannot be assessed accurately by existing attacks. Specifically, we find that conventional metrics measuring targeted and untargeted robustness do not appropriately reflect a model's ability to withstand attacks from one set of source classes to another set of target classes. To address the shortcomings of existing methods, we formally define a new metric, termed group-based robustness, that complements existing metrics and is better-suited for evaluating model performance in certain attack scenarios. We show empirically that group-based robustness allows us to distinguish between models' vulnerability against specific threat models in situations where traditional robustness metrics do not apply. Moreover, to measure group-based robustness efficiently and accurately, we 1) propose two loss functions and 2) identify three new attack strategies. We show empirically that with comparable success rates, finding evasive samples using our new loss functions saves computation by a factor as large as the number of targeted classes, and finding evasive samples using our new attack strategies saves time by up to 99% compared to brute-force search methods. Finally, we propose a defense method that increases group-based robustness by up to 3.52 times.

Please check out the [paper](https://www.ndss-symposium.org/wp-content/uploads/2024-84-paper.pdf) (also on [arXiv](https://arxiv.org/abs/2306.16614)) and the [NDSS talk slides](https://www.ndss-symposium.org/wp-content/uploads/2024-84-slides.pdf).
