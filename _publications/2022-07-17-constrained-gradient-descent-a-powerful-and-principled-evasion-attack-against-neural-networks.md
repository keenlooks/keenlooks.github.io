---
title: "Constrained Gradient Descent: A Powerful and Principled Evasion Attack Against Neural Networks"
collection: publications
permalink: /publications/2022-07-17-constrained-gradient-descent-a-powerful-and-principled-evasion-attack-against-neural-networks
redirect_from: 
  - /cgd/
  - /constrained-gradient-descent/
  - /constrained/
date: 2022-07-17
venue_short: "ICML'22"
venue: "Proceedings of the 39th International Conference on Machine Learning"
type: "Publication"
excerpt: ""
authors_short: "W. Lin, <u>K. Lucas</u>, L. Bauer, M. K. Reiter, M. Sharif"
authors: "Weiran Lin, <u>Keane Lucas</u>, Lujo Bauer, Michael K. Reiter, and Mahmood Sharif"
citation: "Weiran Lin, Keane Lucas, Lujo Bauer, Michael K. Reiter, Mahmood Sharif. Constrained Gradient Descent: A Powerful and Principled Evasion Attack Against Neural Networks. In Proc. ICML'22."
paperurl: '/files/icml2022-better-attacks.pdf'
bibtex: /files/icml2022-better-attacks.bib
---
We propose new, more efficient targeted whitebox attacks against deep neural networks. Our attacks better align with the attacker’s goal: (1) tricking a model to assign higher probability to the target class than to any other class, while (2) staying within an $\epsilon$-distance of the attacked input. First, we demonstrate a loss function that explicitly encodes (1) and show that Auto-PGD finds more attacks with it. Second, we propose a new attack method, Constrained Gradient Descent (CGD), using a refinement of our loss function that captures both (1) and (2). CGD seeks to satisfy both attacker objectives—misclassification and bounded $L_p$-norm—in a principled manner, as part of the optimization, instead of via ad hoc postprocessing techniques (e.g., projection or clipping). We show that CGD is more successful on CIFAR10 (0.9–4.2%) and ImageNet (8.6–13.6%) than state-of-the-art attacks while consuming less time (11.4–18.8%). Statistical tests confirm that our attack outperforms others against leading defenses on different datasets and values of $\epsilon$.

Please check out the [paper](/files/icml2022-better-attacks.pdf), [slides](/files/icml2022-better-attacks-slides.pdf), or [talk video](https://slideslive.com/38984150).

