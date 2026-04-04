#!/bin/bash
# Minify and obfuscate JS/CSS for production
# Prerequisites: npm install -g terser csso-cli

set -e

echo "Minifying app.js..."
npx terser app.js -o app.min.js -c -m --mangle-props=false

echo "Minifying admin/app.js..."
npx terser admin/app.js -o admin/app.min.js -c -m --mangle-props=false

echo "Minifying style.css..."
npx csso style.css -o style.min.css

echo "Minifying admin/style.css..."
npx csso admin/style.css -o admin/style.min.css

echo "Done! Update HTML files to reference .min.js and .min.css"
echo "  index.html: app.js → app.min.js, style.css → style.min.css"
echo "  admin/index.html: app.js → app.min.js, style.css → style.min.css"
