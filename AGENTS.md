# Agent Factory Extension Project

- This checkout owns the VS Code extension, its UI, adapters, tests and VSIX.
- Before choosing an edit target, read the three-domain boundary in the [extension project rules](../docs/skills/rule-extension-development/SKILL.md). Distributed Skills serve product users; plugin and extension project Skills serve their respective developers.
- Read [architecture](../docs/skills/info-extension-architecture/SKILL.md) and the relevant design under `../docs/skills/`.
- Do not apply the plugin repository’s Python tests, cachebuster or publication procedure to this checkout.
- Coordinate the matching plugin release using its version and publication evidence.
- Keep unrelated changes intact. Shared release coordination grants no extra publication authority.

- 봇 설정에는 Human이 요청하지 않은 적용 범위·시스템 우선순위·빈 입력의 기본값 동작 등 상시 부연 안내 문구를 추가하지 않습니다. 간결한 항목 이름과 필요한 저장·오류 상태만 표시합니다. Human이 제거한 설명을 다른 표현이나 툴팁으로 다시 넣지 않습니다.
- 봇 프롬프트 편집란 위에는 캐릭터명·프롬프트 제목을 표시하지 않습니다. 입력란의 접근성 이름은 유지합니다.
- 봇 답변 말풍선은 닫기 버튼만 사용하며 답변 접기·펼치기 컨트롤을 추가하지 않습니다. 긴 답변은 스크롤로 읽을 수 있어야 합니다.
