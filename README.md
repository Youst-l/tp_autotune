tp_autotune - because naming things is hard.

The goal of this ~~project~~ total hack is to take data from Tidepool and make it usable by the Autotune feature from oref0. It currently does this in probably the worst ways possible (if it works at all), but it has very lofty dreams of someday becoming a genuinely useful thing.

This comes with no warranty nor guarantee of accuracy, efficiency, or... well anything really.

This tool currently assumes that you have a `json` dump of your Tidepool data (using command-line-data-tools or the like) _AND_ have `oref0` globally installed (this will hopefully be remedied soon via a `Docker` container).

Usage (if you dare):
```
yarn tune --start-date <YYYY-MM-DD> --end-date <YYYY-MM-DD> --source <path to `json` dump>
```

This will generate a _lot_ of files in a `data` directory that vaguely mirror the files that would be generated by `oref0-autotune` and, if you're very very lucky, will spit out the proper output from Autotune.
