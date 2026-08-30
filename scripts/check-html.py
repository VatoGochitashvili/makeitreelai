#!/usr/bin/env python3
"""Fail if any page's block tags are unbalanced.

Added after a regex rewrite of the nav silently ate a page's <header> and half
its nav across six files. Everything still returned 200 and `node --check`
was happy, because broken HTML is not a syntax error — the browser just
reparents the wreckage. This is the check that would have caught it.
"""
import re, sys, glob, os
TAGS = ["html", "body", "head", "nav", "header", "main", "section", "article", "div"]
root = os.path.join(os.path.dirname(__file__) or ".", "public")
bad = 0
for p in sorted(glob.glob("public/**/*.html", recursive=True)):
    s = open(p).read()
    for t in TAGS:
        o = len(re.findall(rf"<{t}[\s>]", s))
        c = len(re.findall(rf"</{t}>", s))
        if o != c:
            print(f"✗ {p}: <{t}> {o} open / {c} close")
            bad += 1
print("✗ unbalanced HTML" if bad else "✓ all pages balanced")
sys.exit(1 if bad else 0)
