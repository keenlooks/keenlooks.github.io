---
permalink: /terms/
title: "Terms and Privacy Policy"
description: "What this site collects and where your data goes: analytics, the research chat, the Observatory's data relay, and tools that never upload your files."
modified: 2026-10-27
---

{% include base_path %}

This page says what happens to your data when you visit this site. It is a personal website: there are no accounts, no comments, no ads and nothing for sale. I will never share your email address or other personal information with anyone without your consent.

## Hosting

The site is hosted on GitHub Pages. Like any web host, GitHub receives your IP address and browser details when you load a page; see the [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). The site's font (<span translate="no" class="notranslate">Source Sans 3</span>) loads from Google Fonts, so Google also sees that request.

## Google Analytics

I use Google Analytics (GA4) to see which pages people visit and roughly where visitors come from. It sets first-party cookies and sends page views and basic device information to Google; I see only aggregate reports, not individual visitors. Google's handling of this data is described in the [Google Privacy Policy](https://policies.google.com/privacy). You can block it with your browser's tracking protection, a content blocker, or Google's [opt-out add-on](https://tools.google.com/dlpage/gaoptout).

## The research chat

The "Ask About My Research" box at the bottom of most pages is an AI assistant. When you send a message:

* The text of that message goes to a small Cloudflare Worker that I run, which passes it to Anthropic's API (Claude) together with a fixed description of my work, and returns the reply. Your browser's language setting (a short code such as <span translate="no" class="notranslate">en-US</span>) goes with it, so the assistant can answer in your language. The Worker does not store your messages. Cloudflare and Anthropic process the request as described in the [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/) and the [Anthropic Privacy Policy](https://www.anthropic.com/legal/privacy).
* The conversation is saved in your own browser's local storage, so it follows you from page to page on this site. It stays there until you press the reset button in the chat header (or clear this site's data in your browser). It is not sent anywhere else.
* Please do not type anything private into the chat.

Replies are formatted with <span translate="no" class="notranslate">[marked](https://github.com/markedjs/marked)</span> (MIT licence), served from this site.

## The tools run in your browser

PDF Toolbench, Image Studio, Diff Checker and QR Studio process your files entirely inside your browser. The files you open in them are not uploaded to this site or to anyone else. Some pages remember small things in your browser's local storage, such as your light or dark theme choice, a saved signature in PDF Toolbench, recent searches, or whether you have seen a page's tour; that data stays on your device.

## Pages that load live public data

Some interactive pages contact third-party services directly from your browser to load public data. The Observatory, for example, loads live feeds from public scientific and government sources (earthquake, space weather and weather services, among others); those services see your IP address like any website you visit. For the aircraft, flight restriction and GPS notice layers it asks a small Cloudflare Worker that I run, which keeps only the time of the most recent visit (to decide when to refresh its data), not who visited. A few talk pages embed YouTube videos, and YouTube may set cookies when a video loads.

## Contact

Questions about this page: [{{ site.author.email }}](mailto:{{ site.author.email }}).
