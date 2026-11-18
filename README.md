# gta6-forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

An analog-ensemble forecaster of Grand Theft Auto VI's launch-day Twitch viewers, hour by hour.

Each comparable launch in the case is turned into a release-day curve: log ratios of hours 2..24 to its own hour 1.
Curves are weighted by how closely the launch resembles the target:

- **size of hour 1**: a launch already huge at hour 1 grows less (Gaussian kernel on ln viewers);
- **momentum into hour 1**: ln(hour 1 / hour 0), climbing vs fading at the checkpoint;
- **platforms**: console-only targets lean on console-only analogs (PC launches unlock everyone at once);
- **unlock style**: rolling midnight-local launches over single global unlocks;
- **data quality**: early-access-contaminated and weak analogues count less.

Each hour's forecast is a weighted mixture of normals around the analogs' log ratios, with a smoothing width that
grows with the horizon; its 5/25/50/75/95% quantiles times hour 1's print are written out. The knobs were tuned by
leave-one-out over the comparables (each launch forecast from the others), where it scores a mean pinball loss of
about 0.26 against the persistence baseline's 0.32 (0.17 against 0.28 on console-only launches).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22.18+ (type stripping), standard library only, no network.
