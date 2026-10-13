# 已批准的合成案例资料

【合成任务】一家虚构的三人内容团队需要 AI 选题助手的 MVP 交付包。界面输入三个选题关键词，生成五条选题建议，每条包含标题、适用受众、依据与待验证项；空输入要给出明确错误说明。不接入真实模型或客户系统。当前岗位只读：研究、规格、接口、代码草稿、审阅和验收说明均在会话中交付，不写文件、不发布、不部署。

## 用户验收项

- 区分合成需求、已知事实与待验证假设
- 产品规格包含正常输入、空输入、错误状态和最小范围
- 前后端代码草稿与同一接口契约一致，缺少真实运行证据的检查标为 NOT_VERIFIED
- 审阅 FAIL 明确问题、证据和修复目标，由用户决定是否发起修复与复验
- 市场内容只使用确认过的产品能力，增长结果仍待验证
- 交付运营团队汇总所有产物、阻塞项和用户验收清单，最终验收归用户

岗位默认仅有此知识目录的读取权限。全部客户与业务材料均为虚构示例；不包含凭据或真实客户资料。

## 本岗位的团队与阶段

[
  {
    "team": "研发团队",
    "sponsor": "chief-technology-officer",
    "lead": "engineering-lead",
    "members": [
      "engineering-lead",
      "software-architect",
      "frontend-developer",
      "backend-developer",
      "test-engineer"
    ],
    "runbook": {
      "id": "engineering-validation",
      "teamId": "engineering",
      "name": "技术草稿、独立审阅与修复",
      "sources": [
        "method-metagpt",
        "method-agency",
        "method-gstack",
        "method-omc"
      ],
      "stages": [
        {
          "id": "contract",
          "mode": "relay",
          "mentions": [
            "engineering-lead",
            "software-architect"
          ],
          "instruction": "用户提供产品规格；负责人说明交付边界，架构师明确接口请求、响应、正常与错误行为。",
          "outputs": [
            "engineering-plan",
            "interface-contract"
          ],
          "acceptance": [
            "输入和响应字段完整",
            "空输入、错误状态和不接入真实模型的约束明确"
          ]
        },
        {
          "id": "implementation",
          "mode": "parallel",
          "mentions": [
            "frontend-developer",
            "backend-developer"
          ],
          "instruction": "用户提供同一份已确认接口契约。分别给出前端和后端最小实现代码草稿及待运行测试；不自行写文件或运行服务。",
          "outputs": [
            "frontend-draft",
            "backend-draft"
          ],
          "acceptance": [
            "双方遵守同一契约",
            "未运行的测试不标为通过"
          ]
        },
        {
          "id": "review",
          "mode": "relay",
          "mentions": [
            "engineering-lead",
            "test-engineer"
          ],
          "instruction": "用户提供前后端草稿与契约。负责人整合材料，测试工程师独立给出 PASS、FAIL 或 NOT_VERIFIED，逐项说明预期、实际、证据和需要修复的岗位。",
          "outputs": [
            "integration-summary",
            "qa-verdict"
          ],
          "acceptance": [
            "验证范围和证据明确",
            "结论不等同于模型回合终态"
          ]
        }
      ],
      "repair": {
        "onVerdict": "FAIL",
        "mode": "parallel",
        "mentions": [
          "frontend-developer",
          "backend-developer"
        ],
        "instruction": "用户只把明确的问题和证据交给涉及的实现岗位，修复指定问题并提交修复说明。不会自动重新派发。",
        "outputs": [
          "corrected-drafts",
          "repair-notes"
        ],
        "reviewStage": "review",
        "onExhausted": "operator_escalation"
      },
      "finalReview": {
        "reviewers": [
          "test-engineer"
        ],
        "criteria": [
          "草稿一致性可被检查",
          "真实运行仍未验证的项不被隐藏"
        ],
        "decisionOwner": "operator"
      }
    }
  }
]

用户显式发起每个阶段。回合 completed 不等于验收 PASS；没有运行证据的检查标为 NOT_VERIFIED。修复最多 3 次，达到上限后交给用户决定。

## 交接要求

交接保留目标、产物、证据、约束、未解决项、下一阶段请求及验收标准。跨群组的关键产物由用户审阅后放进下一阶段输入，不隐式共享。
