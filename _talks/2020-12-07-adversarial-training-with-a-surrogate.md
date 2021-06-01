---
title: "Workshop Presentation: Adversarial Training with a Surrogate"
collection: talks
permalink: /talks/2020-12-07-adversarial-training-with-a-surrogate
date: 2020-12-07
venue: "Neurips 2020 NewInML Workshop"
excerpt: "Explored surrogate neural network capability to aid adversarial training for hard to differentiate perturbations"
type: "Presentation"
authors_short: "K. Lucas, A. Jasen, and L. Bauer"
citation: "Keane Lucas, Alec Jasen and Lujo Bauer. Adversarial Training with a Surrogate. NeurIPS NewInML Workshop. December 2020"
bibtex: /files/adversarial-training-surrogate.bib
---
Abstract:
Recent work has shown that it is easy to find adversarial examples that cause otherwise highly accurate neural networks to fail. To make these neural networks more robust, adversarial training is often used, which requires finding the most harmful perturbations of a datapoint that do not change the datapoint's class. Previous research uses the classifier's first-order gradients and gradient ascent to solve this inner maximization loop. However, adversarial examples defined by some perturbation sets do not have explicit first-order gradients and remain effective. Commonly used heuristics to select adversarial examples in this setting, such as random and worst-of-k, do not leverage information gained during adversarial training to select more optimal examples. We explore whether adversarial training guided by a neural net can use information accrued during the training process to have computational costs similar to random choice (dataset augmentation) but performance (high accuracy and low mean harm) rivaling worst-of-k search. We consider varying perturbation sets of rotations, translations, and brightness changes. The data we use comes from the benchmark MNIST and the CIFAR-10 datasets.

[See video presentation here](https://youtu.be/NQM0_7q6F5I)

[Download slides here](/files/adversarial-training-surrogate-slides.pdf)

Recommended citation: Keane Lucas, Alec Jasen and Lujo Bauer. Adversarial Training with a Surrogate. NeurIPS NewInML Workshop. December 2020