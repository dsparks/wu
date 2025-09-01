# Sun Times facet
This update removes the Pressure (inHg) chart and adds a Sun Times table showing:
- Sunrise
- Solar noon
- Golden hour (start = 60 minutes before sunset; simple heuristic)
- Sunset

## Implementation notes
- API: https://api.sunrisesunset.io/json with `date` and `timezone` params.
- The facet is rendered inside `#facet-sun` and populated into `#suntimes-table`.
- Styling ensures the facet aligns exactly with other charts via the shared `.facet` wrapper.

To adjust the number of days displayed, change the `slice(0, 7)` inside `renderSunTable` call in `app.js`.
