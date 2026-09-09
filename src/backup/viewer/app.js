'use strict';
(() => {
  const data = JSON.parse(document.getElementById('archive-data').textContent);
  const $ = (id) => document.getElementById(id);
  const format = new Intl.NumberFormat('ru-RU');
  const date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : 'Дата неизвестна';
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const size = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} МБ` : `${Math.ceil(bytes / 1024)} КБ`;
  const types = [['all', 'Все сообщения'], ['image', 'Картинки'], ['audio', 'Аудио'], ['video', 'Видео'], ['missing', 'Недоступные']];
  let chat = data.chats[0], filter = 'all', filtered = [], shown = 0;
  const matches = (m, type) => type === 'all' || m.attachments.some((a) => type === 'missing' ? !a.url : a.kind === type && a.url);
  const setPressed = (button, active) => { button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); };
  function showImage(url) {
    $('large-image').src = url;
    $('image-download').href = url;
    $('lightbox').showModal();
  }
  $('close-image').onclick = () => $('lightbox').close();
  $('lightbox').onclick = (event) => { if (event.target === $('lightbox')) $('lightbox').close(); };
  function attachmentView(a) {
    const container = el('div', 'attachment');
    if (!a.url) {
      const reason = a.status === 'unavailable' ? 'Оригинал уже недоступен в Telegram'
        : a.status === 'unsupported' ? 'Этот тип вложения не сохранён'
          : a.status === 'blocked_by_limit' ? 'Размер превышает лимит архива'
            : a.status === 'pending' ? 'Оригинал ещё не загружен в эту копию' : 'Оригинал не удалось загрузить';
      container.append(el('div', 'missing', reason));
      return container;
    }
    if (a.kind === 'image') {
      const button = el('button', 'photo-button');
      button.setAttribute('aria-label', 'Увеличить изображение');
      const image = el('img'); image.src = a.url; image.loading = 'lazy'; image.alt = 'Изображение из архива';
      image.onerror = () => { image.alt = 'Браузер не открыл изображение. Используйте ссылку на файл ниже.'; };
      button.append(image); button.onclick = () => showImage(a.url); container.append(button);
    } else if (a.kind === 'audio' || a.kind === 'video') {
      const player = el(a.kind); player.controls = true; player.preload = 'none';
      const source = el('source'); source.src = a.url; if (a.mime) source.type = a.mime;
      player.append(source); container.append(player);
      player.addEventListener('play', () => document.querySelectorAll('audio,video').forEach((other) => { if (other !== player) other.pause(); }));
      player.addEventListener('error', () => container.append(el('div', 'missing', 'Браузер не воспроизводит этот формат. Откройте файл в обычном плеере.')), { once: true });
    }
    const meta = el('div', 'file-meta');
    const link = el('a', '', a.kind === 'file' ? a.name : 'Открыть файл');
    link.href = a.url; link.target = '_blank'; link.rel = 'noopener';
    const download = el('a', '', 'Сохранить'); download.href = a.url; download.download = a.name;
    meta.append(link, download, el('span', '', size(a.size)));
    if (!a.original) meta.append(el('span', 'badge', 'Копия из кэша'));
    container.append(meta);
    return container;
  }
  function messageView(m) {
    const card = el('article', 'message'); card.id = `message-${m.id}`;
    const meta = el('div', 'meta');
    meta.append(el('span', 'sender', m.sender || 'Сообщение'), el('time', '', date(m.date)), el('span', '', `№ ${m.id}`));
    if (m.deleted) meta.append(el('span', 'badge', 'Удалено в Telegram'));
    card.append(meta);
    if (m.replyTo) card.append(el('div', 'reply', `В ответ на сообщение № ${m.replyTo}`));
    if (m.text) card.append(el('p', 'text', m.text));
    if (m.attachments.length) {
      const attachments = el('div', 'attachments');
      m.attachments.forEach((a) => attachments.append(attachmentView(a))); card.append(attachments);
    }
    if (m.transcript) {
      const details = el('details', 'transcription'); details.open = true;
      details.append(el('summary', '', 'Расшифровка'), el('p', 'transcript', m.transcript)); card.append(details);
    }
    if (!m.text && !m.transcript && !m.attachments.length) card.append(el('p', 'subtle', 'Служебное сообщение'));
    return card;
  }
  function more() {
    const fragment = document.createDocumentFragment();
    filtered.slice(shown, shown + 60).forEach((m) => fragment.append(messageView(m)));
    shown = Math.min(shown + 60, filtered.length);
    $('messages').append(fragment); $('more').hidden = shown >= filtered.length;
    $('count').textContent = `${format.format(filtered.length)} сообщений · показано ${format.format(shown)}`;
  }
  function render() {
    const query = $('search').value.trim().toLocaleLowerCase();
    filtered = chat.messages.filter((m) => matches(m, filter) && `${m.text}\n${m.transcript}\n${m.sender}\n${m.id}`.toLocaleLowerCase().includes(query));
    filtered.sort((a, b) => $('order').value === 'old' ? a.id - b.id : b.id - a.id);
    $('messages').replaceChildren(); shown = 0;
    if (!filtered.length) $('messages').append(el('div', 'empty', 'Ничего не найдено. Попробуйте другой запрос или фильтр.'));
    more();
    [...$('filters').children].forEach((button) => setPressed(button, button.dataset.filter === filter));
  }
  function choose(next) {
    chat = next; filter = 'all'; $('search').value = '';
    $('title').textContent = chat.title;
    const attachments = chat.messages.flatMap((m) => m.attachments);
    $('summary').textContent = `${format.format(chat.messages.length)} сообщений · ${format.format(attachments.filter((a) => a.url).length)} сохранённых вложений · ${format.format(attachments.filter((a) => !a.url).length)} недоступных`;
    $('snapshot').textContent = `Снимок от ${date(chat.snapshotAt)}. Обновляется при создании новой резервной копии.`;
    [...$('chats').children].forEach((button) => setPressed(button, button.dataset.source === chat.sourceId));
    $('filters').replaceChildren();
    types.forEach(([type, label]) => {
      const count = chat.messages.filter((m) => matches(m, type)).length;
      if (!count && type !== 'all') return;
      const button = el('button', '', `${label} · ${format.format(count)}`); button.dataset.filter = type;
      button.onclick = () => { filter = type; render(); }; $('filters').append(button);
    });
    render();
  }
  data.chats.forEach((item) => {
    const button = el('button'); button.dataset.source = item.sourceId;
    button.append(el('strong', '', item.title), el('small', '', `${format.format(item.messages.length)} сообщений`));
    button.onclick = () => choose(item); $('chats').append(button);
  });
  let searchTimer;
  $('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); };
  $('order').onchange = render; $('more').onclick = more;
  if (chat) choose(chat);
})();
