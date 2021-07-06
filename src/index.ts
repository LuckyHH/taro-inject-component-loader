import generate from '@babel/generator'
import traverse from '@babel/traverse'
import utils from '@babel/types'
import { parse } from '@babel/parser'
import { getOptions } from 'loader-utils'
import { validate } from 'schema-utils'

const schema = {
  type: 'object',
  properties: {
    importPath: {
      type: 'string',
    },
    isPage: {
      instanceof: 'Function',
    },
  },
  additionalProperties: false,
}

export default function(source: string) {
  // @ts-ignore
  const webpackEnv = this

  const options = getOptions(webpackEnv)

  validate(schema as any, options, { name: 'taro-inject-component-loader' })

  const { importPath = '', componentName = 'WebpackInjected', isPage = defaultJudgePage } =
    options || {}

  // 获取原始文件地址
  const filePath = webpackEnv.resourcePath

  if (typeof isPage === 'function' && isPage(filePath)) {
    // 生成 AST
    const ast: any = parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript', 'classProperties'],
    })

    // 如果有导入申明，则默认表示已手动导入了组件
    let insert = false

    // 保存所有顶层的声明
    const declarations = new Map()

    traverse(ast, {
      // 查找是否有导入
      ImportDeclaration(path) {
        if (path.node.source.value === importPath) {
          insert = true
        }
      },

      // 收集页面文件里的所有申明
      // 类组件
      ClassDeclaration(path) {
        // 如果不是顶层的申明，则直接返回
        if (path.parent.type !== 'Program') return

        const type = path.node.type
        const name = path.node.id.name || 'anonymous-class'
        declarations.set(name, type)
      },

      // 函数申明
      FunctionDeclaration(path) {
        // 如果不是顶层的申明，则直接返回
        if (path.parent.type !== 'Program') return

        const type = path.node.type
        const name = path.node.id?.name || 'anonymous-function'
        declarations.set(name, type)
      },

      // 表达式申明
      VariableDeclaration(path) {
        // 如果不是顶层的申明，则直接返回
        if (path.parent.type !== 'Program') return

        path.node.declarations.forEach((declaration: any) => {
          // const a = () => {}
          if (declaration.init.type === 'ArrowFunctionExpression') {
            const type = declaration.init?.type
            const name = declaration.id?.name
            declarations.set(name, type)
          }

          // const a = function(){}
          if (declaration.init.type === 'FunctionExpression') {
            const type = declaration.init.type
            const name = declaration.id.name
            declarations.set(name, type)
          }

          // const a = class {}
          if (declaration.init.type === 'ClassExpression') {
            const type = declaration.init.type
            const name = declaration.id.name
            declarations.set(name, type)
          }
        })
      },
    })

    if (!insert) {
      // 记录组件插入状态
      const state = {
        importedDeclaration: false,
        importedComponent: false,
      }

      traverse(ast, {
        // 添加申明
        ImportDeclaration(path) {
          if (!state.importedDeclaration) {
            state.importedDeclaration = true
            path.insertBefore(
              utils.importDeclaration(
                [utils.importDefaultSpecifier(utils.identifier('' + componentName))],
                utils.stringLiteral('' + importPath),
              ),
            )
          }
        },

        // 默认导出的为页面组件
        ExportDefaultDeclaration(path) {
          // 如果默认导出的是函数
          if (path.node.declaration.type === 'FunctionDeclaration') {
            const mainFnBody = path.node.declaration.body.body
            const length = mainFnBody.length
            const last = mainFnBody[length - 1]
            insertComponent(last, '' + componentName, state)
          }

          // 默认导出箭头函数
          if (path.node.declaration.type === 'ArrowFunctionExpression') {
            // export default () => { return <View></View> }
            if (path.node.declaration.body.type === 'BlockStatement') {
              const mainFnBody = path.node.declaration.body.body
              const length = mainFnBody.length
              const last = mainFnBody[length - 1]
              insertComponent(last, '' + componentName, state)
            } else {
              // export default () => <View></View>
              insertComponent(path.node.declaration.body, '' + componentName, state)
            }
          }
          // 默认导出类
          if (path.node.declaration.type === 'ClassDeclaration') {
            traverse(
              path.node,
              {
                ClassMethod(path) {
                  if ((path.node.key as any).name === 'render') {
                    const body = path.node.body.body || []
                    const last = body[body.length - 1]
                    insertComponent(last, '' + componentName, state)
                    return
                  }
                },
              },
              path.scope,
              path,
            )
          }

          // 如果默认导出的是一个申明
          if (path.node.declaration.type === 'Identifier') {
            const name = path.node.declaration.name
            const componentType = declarations.get(name)
            handelIdentifier({ componentType, path, componentName, state, name })
          }
          // class A {} or const A = () => {}
          // export default connect()(A)
          if (path.node.declaration.type === 'CallExpression') {
            if ((path as any).node.declaration.callee.callee.name === 'connect') {
              const name = (path as any).node.declaration.arguments[0].name
              const componentType = declarations.get(name)
              handelIdentifier({ componentType, path, componentName, state, name })
            }
          }
        },
      })
      source = generate(ast).code
    }
  }

  return source
}

function createElement(name: string) {
  const reactIdentifier = utils.identifier('React')
  const createElementIdentifier = utils.identifier('createElement')
  const callee = utils.memberExpression(reactIdentifier, createElementIdentifier)
  return utils.callExpression(callee, [utils.identifier(name)])
}

function createJSX(name: string) {
  return utils.jSXElement(
    utils.jSXOpeningElement(utils.jsxIdentifier('' + name), [], true),
    null,
    [],
    true,
  )
}

function insertComponent(node: any, componentName: string, state: any) {
  if (node?.type === 'ReturnStatement') {
    // createElement
    if (node.argument?.callee?.property?.name === 'createElement' && !state.importedComponent) {
      state.importedComponent = true
      const reactCreateArguments = node.argument.arguments
      reactCreateArguments.push(createElement(componentName))
    }
    // JSX
    if (node.argument?.type === 'JSXElement' && !state.importedComponent) {
      state.importedComponent = true
      node.argument.children.push(createJSX(componentName))
    }
  }
  if (node.type === 'JSXElement' && !state.importedComponent) {
    node.children.push(createJSX(componentName))
  }
}

function defaultJudgePage(filePath: string) {
  // 兼容 windows 路径
  const formatFilePath = filePath.replace(/\\/g, '/')
  return /(package-.+\/)?pages\/.+\/index\.[tj]sx$/.test(formatFilePath)
}

function handelIdentifier({ componentType, path, componentName, state, name }: any) {
  if (componentType === 'FunctionExpression' || componentType === 'FunctionDeclaration') {
    // const A = function (){} or functionA () {}
    // export default A
    traverse(path.parent, {
      FunctionExpression(path) {
        const mainFnBody = path.node?.body?.body
        const length = mainFnBody.length
        const last = mainFnBody[length - 1]
        insertComponent(last, '' + componentName, state)
      },
      FunctionDeclaration(path) {
        const mainFnBody = path.node?.body?.body
        const length = mainFnBody.length
        const last = mainFnBody[length - 1]
        insertComponent(last, '' + componentName, state)
      },
    })
  } else if (componentType === 'ClassExpression' || componentType === 'ClassDeclaration') {
    // const A = class {} or class A {}
    // export default A
    traverse(path.parent, {
      ClassMethod(path) {
        if ((path.node.key as any).name === 'render') {
          const body = path.node.body.body || []
          const last = body[body.length - 1]
          insertComponent(last, '' + componentName, state)
        }
      },
      ClassDeclaration(path) {
        path.node.body.body.map((cmItem: any) => {
          if (cmItem.key.name === 'render') {
            const body = cmItem.body.body || []
            const last = body[body.length - 1]
            insertComponent(last, '' + componentName, state)
          }
        })
      },
    })
  } else if (componentType === 'ArrowFunctionExpression') {
    // const A = () => {}
    // export default A
    traverse(path.parent, {
      VariableDeclarator(path) {
        if (path.node.id.type !== 'Identifier') return
        if (path.node.init?.type !== 'ArrowFunctionExpression') return
        // const A = () => {}
        // export default A
        if (path.node.init.body.type == 'BlockStatement') {
          if (name === path.node.id.name) {
            const mainFnBody = path.node.init.body.body
            const length = mainFnBody.length
            const last = mainFnBody[length - 1]
            insertComponent(last, '' + componentName, state)
          }
        } else {
          // const A = () => <div></div>
          // export default A
          insertComponent(path.node.init.body, '' + componentName, state)
        }
      },
    })
  }
}
