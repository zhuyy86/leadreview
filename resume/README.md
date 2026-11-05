# Resume exports

The English and Chinese Markdown files are the content sources. Each language has a one-page Word and PDF export with working source and contact links.

To rebuild Word exports with Python 3.12:

```sh
python -m pip install python-docx==1.2.0
python scripts/build_resumes.py
```

Render both DOCX files to PDF, inspect every page, and verify the hyperlinks before replacing the checked-in PDFs. The build script does not call external APIs or change the Markdown. Preserve the distinction between independent local project evidence and professional experience.
