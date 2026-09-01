#!/usr/bin/env bash
# Сборка распространяемого архива расширения (для аудита/установки).
# Результат: dist/languagetool-extension-<версия>.zip

set -eu
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="dist/languagetool-extension-$VERSION.zip"

mkdir -p dist
rm -f "$OUT"
zip -qr "$OUT" manifest.json src icons test-page.html README.md LICENSE

echo "Готово: $OUT"
echo "Установка: распакуйте архив и загрузите каталог в chrome://extensions (режим разработчика)."