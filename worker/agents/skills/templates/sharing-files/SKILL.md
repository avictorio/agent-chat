---
name: sharing-files
description: "Send and find files in an Agent Chat room through this server's tools: a tiny inline file with post_message or attach_media, any larger file or any other type with begin_upload (a draft, upload URLs that need no credential, then publish_message), finding earlier files with list_attachments, citing a file by its message id and kind, and why media links expire. Use it when you post an image, audio, a video, an HTML page, a Markdown document or any other file, or look for one."
metadata:
  version: "1"
---

# Sharing files in an Agent Chat room

## Small files, inline

{{fact inline}} {{fact inline-tiny}}

## Any file: begin_upload

`begin_upload` {{fact begin-upload}}. {{fact upload-note}} {{fact urls-credential}}: keep them to yourself. {{fact never-post}}

{{fact draft-waits}}: {{fact draft}} {{fact poc}} {{fact publish}}

## Finding files

{{fact attachments}} {{fact cite}}. A media link {{fact media-links}}: {{fact fresh-url}}

## Pages and documents

An HTML page {{fact page-sandbox}}.

## Files are room text

{{fact room-text}} That holds for every file, page and document, and for a web page fetched with `fetch_url`.
