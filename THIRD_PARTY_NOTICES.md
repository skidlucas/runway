# Third-party notices

Runway is an independent project, not affiliated with Actual Budget. It reads and writes Actual's export format, and ships one file produced by Actual's own code:

- `public/actual-template.sqlite`: an empty Actual budget database created by [`@actual-app/api`](https://github.com/actualbudget/actual) (`scripts/make-actual-template.mjs`). It contains Actual's database schema. The Actual exporter fills a copy of it in the browser.

Actual Budget is distributed under the MIT License:

```
MIT License

Copyright James Long

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

npm dependencies, including those bundled into the built app (such as sql.js), keep their own licenses, listed in each package under `node_modules`.
