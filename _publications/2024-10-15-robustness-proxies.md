---
title: "Training Robust ML-based Raw-Binary Malware Detectors in Hours, not Months"
collection: publications
permalink: /publications/2024-10-15-robustness-proxies
redirect_from: 
  - /greedyblock/
  - /robustproxies/
  - /robust-proxies/
  - /greedy-block/
  - /robustness-proxies/
  - /robustnessproxies/
date: 2024-10-15
venue_short: "CCS '24"
venue: "2024 ACM SIGSAC Conference on Computer and Communications Security"
type: "Publication"
excerpt: ""
authors_short: "<u>K. Lucas</u>, W. Lin, L. Bauer, M. K. Reiter, and M. Sharif"
authors: "<u>Keane Lucas</u>, Weiran Lin, Lujo Bauer, Michael K. Reiter, and Mahmood Sharif"
citation: "Keane Lucas, Weiran Lin, Lujo Bauer, Michael K. Reiter, Mahmood Sharif. Training Robust ML-based Raw-Binary Malware Detectors in Hours, not Months. In Proc. CCS '24."
paperurl: '/files/ccs24-training-robust-mlbased-rawbinary-malware-detectors.pdf'
bibtex: /files/robustness-proxies.bib
---

Machine-learning (ML) classifiers are increasingly used to distinguish malware from benign binaries. Recent work has shown that ML-based detectors can be evaded by adversarial examples, but also that one may defend against such attacks via adversarial training. However, adversarial training, and subsequent robustness evaluation, is computationally expensive in the raw-binary malware-detection domain because it requires producing many adversarial examples for both training and evaluation. Prior work found that Greedy-training, a faster robust training technique that forgoes using adversarial examples, showed some promise in producing robust malware detectors. However, Greedy-training was far less effective in inducing robustness than the more expensive adversarial training, and it also severely hurt natural accuracy (i.e., accuracy on the original data). To faster train models, this work presents GreedyBlock-training, an enhanced version of Greedy-training that we empirically show achieves not only state-of-the-art robustness in malware detectors, exceeding even adversarial training, but also retains natural accuracy better than adversarial training. Furthermore, as it does not require creating adversarial (or functional) examples, GreedyBlock-training is significantly faster than adversarial training. Specifically, we show that GreedyBlock-training can produce more robust (+54% on average), more naturally accurate (+7% on average), and more efficiently trained (-91% average computation) malware detectors than prior work. To faster evaluate models, we also develop methods to faster gauge the robustness of ML-based raw-binary malware detectors by introducing robustness proxies, which can be used either to predict which models are likely to be the most robust, thus helping prioritize which detectors to evaluate with expensive attacks, or aiding in deciding which detectors are worthwhile to continue training. Experimentally, we show these proxy measures can find the most robust detector in a pool of detectors while using only ∼20-50% of the computation that would otherwise be required.

Please check out the [paper](/files/ccs24-training-robust-mlbased-rawbinary-malware-detectors.pdf) or the [implementation of GreedyBlock-training](https://doi.org/10.1184/R1/26322505)!