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
    "team": "产品团队",
    "sponsor": "chief-product-officer",
    "lead": "product-manager",
    "members": [
      "product-manager",
      "user-researcher",
      "interaction-designer"
    ],
    "runbook": {
      "id": "product-discovery",
      "teamId": "product",
      "name": "产品发现与规格",
      "sources": [
        "method-agency",
        "method-bmad",
        "method-metagpt"
      ],
      "stages": [
        {
          "id": "research",
          "mode": "parallel",
          "mentions": [
            "user-researcher",
            "interaction-designer"
          ],
          "instruction": "基于合成任务分别整理用户假设、研究缺口和主要用户流程；不能虚构访谈。",
          "outputs": [
            "research-notes",
            "interaction-outline"
          ],
          "acceptance": [
            "事实和假设分开",
            "空输入和错误反馈有说明"
          ]
        },
        {
          "id": "specification",
          "mode": "relay",
          "mentions": [
            "product-manager",
            "interaction-designer"
          ],
          "instruction": "用户提供已审阅的研究和流程材料；产品经理整理范围与验收项，交互设计师据此前驱可信结果补齐交互规格。",
          "outputs": [
            "product-specification",
            "interaction-specification"
          ],
          "acceptance": [
            "范围和排除项明确",
            "每个主要行为可验收"
          ]
        }
      ],
      "finalReview": {
        "reviewers": [
          "product-manager"
        ],
        "criteria": [
          "研究缺口被保留",
          "产品范围、交互和验收一致"
        ],
        "decisionOwner": "operator"
      }
    }
  }
]

用户显式发起每个阶段。回合 completed 不等于验收 PASS；没有运行证据的检查标为 NOT_VERIFIED。修复最多 3 次，达到上限后交给用户决定。

## 交接要求

交接保留目标、产物、证据、约束、未解决项、下一阶段请求及验收标准。跨群组的关键产物由用户审阅后放进下一阶段输入，不隐式共享。
