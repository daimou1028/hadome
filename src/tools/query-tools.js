function makeQueryTools({
  ToolError,
  clip,
  clipMiddle,
  withFull,
  wantName,
  CONFIG_OPEN,
  globalrules,
  webfetch,
  normalizeTodos,
  todoCount,
  spawnAgents,
  seenUrls,
  onTodos,
  readSetting,
  writeSetting,
  askOrPass,
}) {
  return {
    async config(call) {
      const setting = String(call.setting || '').trim();
      if (!setting) {
        throw new ToolError(
          `どの設定かを渡してください。読み書きできるのは: ${CONFIG_OPEN.join(' / ')}`,
          'tool.noSetting'
        );
      }
      if (!CONFIG_OPEN.includes(setting)) {

        throw new ToolError(
          `その設定は相手からは触れません: ${setting}\n` +
            `触れるのは: ${CONFIG_OPEN.join(' / ')}\n` +
            '許しや関門にかかわる設定は、利用者が画面から変えるものです。',
          'tool.settingClosed',
          { setting }
        );
      }
      if (!readSetting) {
        throw new ToolError('この入口では設定を読めません（対話の画面から使ってください）', 'tool.subNoCli');
      }
      if (call.value === undefined) {
        return {
          ok: true,
          target: setting,
          output: `${setting} = ${JSON.stringify(readSetting(setting))}`,
        };
      }
      if (!writeSetting) {
        throw new ToolError('この入口では設定を書けません（対話の画面から使ってください）', 'tool.subNoCli');
      }
      const 前 = readSetting(setting);

      const 答え = await askOrPass({
        kind: 'setting',
        detail: `${setting}\n  いま: ${JSON.stringify(前)}\n  あとで: ${JSON.stringify(call.value)}`,
      });
      if (答え !== 'once' && 答え !== 'always') {
        throw new ToolError(`設定の書き換えは断られました: ${setting}`, 'tool.settingRefused', { setting });
      }
      await writeSetting(setting, call.value);
      return {
        ok: true,
        target: setting,
        output: `${setting} を ${JSON.stringify(前)} から ${JSON.stringify(call.value)} へ変えました。`,
      };
    },

    async codebase_search(call) {
      const query = String(call.query || '').trim();
      if (!query) throw new ToolError('探したい事を query に書いてください', 'tool.noQuery');
      if (!spawnAgents) {
        throw new ToolError(
          'この入口では意味で探せません（対話の画面から使ってください）。字で探すなら search が使えます',
          'tool.subNoCli'
        );
      }
      const 場所 = String(call.path || '').trim();
      const 頼み =
        `この作業場から「${query}」に関わる所を探してください。` +
        (場所 ? `探す先は ${場所} の下だけです。` : '') +
        '\n\n**字が一致する所だけを見ないでください。**言い方が違っても、' +
        'その事をやっている所を探します（名前・註釈・呼び出し先から辿る）。' +
        '\n\n返す形:' +
        '\n  1. <道>:<行> — なぜ関わるか（1 行）' +
        '\n  2. …' +
        '\n\n近い順に、多くて 10 件。**1 件も無ければ「無い」と書いてください**' +
        '（当てはまらない物で埋めない）。';
      const r = await spawnAgents([頼み]);
      if (r.why) throw new ToolError(r.why, 'tool.subFail', { why: r.why });
      const body = r.text || '';
      return { ok: true, target: query, ...withFull(body, clipMiddle(body)) };
    },

    async web_search(call) {
      const query = String(call.query || '').trim();
      if (!query) throw new ToolError('探す言葉を渡してください', 'tool.noQuery');
      let res;
      let html;
      try {
        res = await fetch(webfetch.searchUrl(query), {
          redirect: 'follow',
          headers: { 'user-agent': 'chatgpt-bridge', accept: 'text/html' },
          signal: AbortSignal.timeout(30000),
        });
        html = await res.text();
      } catch (e) {
        throw new ToolError(`探せませんでした: ${e.message}`, 'tool.searchFail', { why: e.message });
      }
      if (!res.ok) {
        throw new ToolError(`探せませんでした（${res.status}）`, 'tool.searchStatus', { status: res.status });
      }
      const hits = webfetch.searchResults(html);
      if (!hits.length) {

        return {
          ok: true,
          target: query,
          output:
            html.length > 2000
              ? `結果を取り出せませんでした（${html.length} 字は返って来ています）。` +
                '探す先の作りが変わった見込みです。**「見つからなかった」ではありません。**'
              : `当たりませんでした: ${query}`,
        };
      }

      if (seenUrls) for (const h of hits) seenUrls.add(h.url);
      const body = hits
        .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
        .join('\n');
      return {
        ok: true,
        target: query,
        ...withFull(body, clipMiddle(body)),
      };
    },

    async web_fetch(call) {
      const url = String(call.url || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new ToolError('http か https の場所を渡してください', 'tool.httpOnly');
      }
      const seen = seenUrls || new Set();
      if (!webfetch.hasProvenance(url, seen)) {

        const answer = await askOrPass({ kind: 'url', detail: url });
        if (answer !== 'once' && answer !== 'always') {
          throw new ToolError(
            `この場所は、この対話にまだ出てきていません: ${url}\n` +
              '利用者が出した場所と、そこから辿れた場所だけを取りに行けます。\n' +
              '要るなら、利用者に場所を書いてもらってください。',
            'tool.urlUnseen',
            { url }
          );
        }
      }
      let res;
      try {
        res = await fetch(url, {
          redirect: 'follow',
          headers: { 'user-agent': 'chatgpt-bridge', accept: 'text/html,text/plain,*/*' },
          signal: AbortSignal.timeout(30000),
        });
      } catch (e) {
        throw new ToolError(`取れませんでした: ${e.message}`, 'tool.fetchFail', { why: e.message });
      }
      if (!res.ok) throw new ToolError(`取れませんでした（${res.status}）: ${url}`, 'tool.fetchStatus', { status: res.status, url });
      const kind = String(res.headers.get('content-type') || '');
      const raw = await res.text();

      if (seenUrls) {
        for (const u of webfetch.collectUrls(raw)) seenUrls.add(u);
        seenUrls.add(String(res.url || url));
      }
      const isHtml = /html/i.test(kind) || /^\s*<(!doctype|html)/i.test(raw);
      const body = isHtml ? webfetch.htmlToText(raw) : raw;
      const title = isHtml ? webfetch.titleOf(raw) : '';

      const hostOf = (u) => {
        try {
          return new URL(u).host;
        } catch {
          return '';
        }
      };
      const 移った = res.url && webfetch.normalizeUrl(res.url) !== webfetch.normalizeUrl(url);
      const 別のサーバ = 移った && hostOf(res.url) && hostOf(res.url) !== hostOf(url);
      const moved = !移った
        ? ''
        : 別のサーバ
          ? `**別の場所へ飛ばされました。**頼まれたのは ${hostOf(url)} ですが、` +
            `着いたのは ${hostOf(res.url)} です:\n  ${res.url}\n` +
            '**下の中身は、頼まれた場所の物ではありません**（ログインの画面などです）。' +
            'これを答えの材料にしないでください。要るなら、上の場所を web_fetch で取り直すか、' +
            '取れないことを利用者に伝えてください。\n\n'
          : `（${res.url} へ移りました）\n`;
      return {
        ok: true,
        target: title || url,
        output: clip(moved + body),
      };
    },

    update_todos(call) {
      const r = normalizeTodos(call.todos);
      if (!r.ok) return { ok: false, output: r.why };
      if (onTodos) onTodos(r.todos);
      const n = todoCount(r.todos);
      return {
        ok: true,
        target: `${n.done}/${n.all}`,

        output: r.fixed
          ? `${n.all} 件を控えました（進行中が 2 件以上あったので、最初の 1 件だけ残しました）`
          : `${n.all} 件を控えました（終わり ${n.done}）`,
      };
    },

    read_rule(call) {
      const name = wantName(call.name, '決まり');

      if (name !== globalrules.RULES_BODY_NAME && !globalrules.listRules(null).includes(name)) {
        throw new ToolError(
          `そんな決まりはありません: ${name}（読める名前は最初の指示の §13 の表に出ています）`,
          'tool.noRule',
          { name }
        );
      }
      return {
        ok: true,
        target: name,
        output: clip(globalrules.readRule(null, name)),
      };
    },

    search_skills(call) {
      const hit = globalrules.searchSkills(null, call.query);
      if (!hit.length) {

        return {
          ok: true,
          target: String(call.query || ''),
          output: '当てはまるものがありませんでした。名前だけの一覧は最初の指示に出ています。',
        };
      }
      return {
        ok: true,
        target: String(call.query || ''),
        output: hit.map((x) => `- ${x.name}: ${x.description}`).join('\n'),
      };
    },

    read_skill(call) {
      const name = wantName(call.name, '手順書');

      if (!globalrules.skillNames(null, { forHuman: true }).includes(name)) {
        throw new ToolError(
          `そんな手順書はありません: ${name}（読める名前は最初の指示に出ています）`,
          'tool.noSkill',
          { name }
        );
      }
      return {
        ok: true,
        target: name,
        output: clip(globalrules.readSkill(null, name), 20000),
      };
    },
  };
}

module.exports = { makeQueryTools };
