---
title: "Perspectives from a Comprehensive Evaluation of Reconstruction-based Anomaly Detection in Industrial Control Systems"
collection: publications
permalink: /publications/2022-09-26-perspectives-from-a-comprehensive-evaluation-of-reconstruction-based-anomaly-detection-in-industrial-control-systems
redirect_from: 
  - /perspectives/
  - /ics-anomaly/
date: 2021-06-07
venue_short: "ESORICS'22"
venue: "27th European Symposium on Research in Computer Security"
type: "Publication"
excerpt: ""
authors_short: "C. Fung, S. Srinarasi, K. Lucas, H. B. Phee, L. Bauer"
authors: "Clement Fung, Shreya Srinarasi, Keane Lucas, Hay Bryan Phee, and Lujo Bauer"
citation: "Clement Fung, Shreya Srinarasi, Keane Lucas, Hay Bryan Phee, Lujo Bauer. Perspectives from a Comprehensive Evaluation of Reconstruction-based Anomaly Detection in Industrial Control Systems. In Proc. ESORICS'22."
paperurl: '/files/esorics2022-ics-anomaly-detection.pdf'
bibtex: /files/esorics2022-ics-anomaly-detection.bib
---
Industrial control systems (ICS) provide critical functions to society and are enticing attack targets. Machine learning (ML) models—in particular, reconstruction-based ML models—are commonly used to identify attacks during ICS operation. However, the variety of ML model architectures, datasets, metrics, and techniques used in prior work makes broad comparisons and identifying optimal solutions difficult. To assist ICS security practitioners in choosing and configuring the most effective reconstruction-based anomaly detector for their ICS environment, this paper: (1) comprehensively evaluates previously proposed reconstruction-based ICS anomaly-detection approaches, and (2) shows that commonly used metrics for evaluating ML algorithms, like the pointF1 score, are inadequate for evaluating anomaly detection systems for practical use. Among our findings is that the performance of anomalydetection systems is not closely tied to the choice of ML model architecture or hyperparameters, and that the models proposed in prior work are often larger than necessary. We also show that evaluating ICS anomaly detection over temporal ranges, e.g., with the range-F1 metric, better describes ICS anomaly-detection performance than the commonly used point-F1 metric. These so-called range-based metrics measure objectives more specific to ICS environments, such as reducing false alarms or reducing detection latency. We further show that using range-based metrics to evaluate candidate anomaly detectors leads to different conclusions about what anomaly-detection strategies are optimal.

Please check out the [paper](/files/esorics2022-ics-anomaly-detection.pdf), [slides](/files/esorics2022-ics-anomaly-detection-slides.pdf), [talk video](https://www.youtube.com/watch?v=vHbY7HsBUKQ), or [code](https://github.com/pwwl/ics-anomaly-detection).

