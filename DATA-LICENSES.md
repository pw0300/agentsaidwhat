# Data licences

The Apache-2.0 code licence does not cover third-party datasets or model weights.

| Source | Terms | Repository policy |
| --- | --- | --- |
| Indic DiarBench, Sarvam AI and AI4Bharat | CC BY 4.0, attribution required | Derived CSVs may ship. Credit the source and describe changes. |
| SOMOS, SOMOS dataset authors | CC BY-NC-SA 4.0 | Non-commercial use and share-alike. Ship download/extract scripts only; `data/voice_probe/NISQA_somos.csv` is untracked and ignored. |
| LibriSpeech, Vassil Panayotov and collaborators | CC BY 4.0, attribution required | Credit the source and describe changes to derived artifacts. |
| CallCenterEN / AIxBlock | Research use only for this project | No derived dataset files are committed. Check upstream terms before downloading. |
| NISQA model weights | Their own upstream licence applies | Weights are downloaded separately and are not redistributed. |

Source attribution:
- Indic DiarBench: https://huggingface.co/datasets/sarvamai/indic-diarbench
- SOMOS: https://zenodo.org/records/7378801
- LibriSpeech: https://www.openslr.org/12
- CallCenterEN: https://huggingface.co/datasets/AIxBlock/91706-real-world-call-center-scripts-english
- NISQA: https://github.com/gabrielmittag/NISQA

Derived benchmark scores are transformations, not original recordings. Preserve these credits alongside redistributed artifacts. Raw recordings, downloaded corpora and weights stay outside git. Research notes may describe experiments without distributing their input data.
