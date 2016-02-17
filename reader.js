#!/usr/bin/env node
'use strict'
const fs = require('fs')
const pdfjs = require('pdfjs-dist')
const _ = require('lodash')
const argv = require('minimist')(process.argv.slice(2))

const data = new Uint8Array(fs.readFileSync(__dirname + '/anexo-i.pdf'))

function parseSegmentsSummary(lines) {
  const regex = /^(\d{2})\.\s+((?:[A-Z])(?:.[^\n]+))/

  return lines.filter(line => regex.test(line))
    .map(line => line.match(regex))
    .map(
      match => ({
        index: match[1],
        description: match[2]
      })
    )
}

pdfjs.getDocument(data).promise.then(document => {
  const numberOfPages = document.pdfInfo.numPages

  document.getPage(1).then(page => {
    page.getTextContent().then(content => {
      const lines = content.items.map(item => item.str)

      let summary = parseSegmentsSummary(lines)
      let segments = summary.map(segment =>
        ({
          segment: segment.description,
          lines: [],
          data: []
        })
      )

      const pagesToParse = [1].concat(
        (argv.page ? [].concat(argv.page) : _.range(1, numberOfPages + 1))
          .filter(page => page !== 1)
      )

      Promise.all(
        pagesToParse.map(p => {
          return new Promise((resolve, reject) => {
            document.getPage(p).then(page => {
              page.getTextContent()
                .then(content => resolve(content))
                .catch(e => reject(e))
            }).catch(e => reject(e))
          })
        })
      ).then(pages => {
        const lines = pages.map(page => page.items.map(line => line.str.trim()))
        .reduce((lines, page) => lines.concat(...page), [])

        const blocks = _.values(segments.reduce((positions, segment) => {
          return positions.concat(
            lines.map((line, index) => {
              if (_.deburr(line).toLowerCase() === _.deburr(segment.segment).toLowerCase()) {
                return {
                  segment: segment.segment,
                  position: index
                }
              }
            }).filter(position => position && position.position)
          )
        }, []).reduce((localized, block, index, blocks) => {
          const end = blocks[index + 1] ? blocks[index + 1].position : lines.length

          return localized.concat({
            segment: block.segment,
            start: Math.min(block.position + 1, lines.length),
            end
          })
        }, []).reduce((revised, block, index, localized) => {
          const maybe = _.takeRight(lines.slice(block.start, block.end), 5).reverse()

          const numberOfLinesToSkip = maybe.reduce((numberOfLines, line, index, lines) => {
            if (/Anexo (IX|IV|V?I{0,3})/.test(_.take(lines, index).join(' '))) {
              return numberOfLines + 1
            }

            return numberOfLines
          }, 0)

          return revised.concat({
            segment: block.segment,
            start: block.start,
            end: block.end - numberOfLinesToSkip
          })
        }, []).reduce((revised, block) => {
          if (! revised[block.segment]) {
            revised[block.segment] = block
          }

          revised[block.segment].end = block.end
          return revised
        }, {}))

        const parsed = blocks.map(segment => {
          return parseSegment(lines.slice(segment.start, segment.end)).map(item => {
            return _.omit(item, 'skip')
          })
        })

        console.log(JSON.stringify(parsed, null, 2))
      }).catch(e => {
        console.error(e.message)
        process.exit(1)
      })
    }).catch(e => {
      console.error(e.message)
      process.exit(1)
    })
  })
}).catch(e => {
  console.error(e.message)
  process.exit(1)
})

function normalizeNcms(ncms) {
  ncms = ncms.filter(ncm => ncm.length)

  if (ncms.length === 0) {
    return []
  }

  if (/^(Capítulos?)/.test(ncms[0])) {
    return [
      ncms.join(' ')
    ]
  }

  return ncms
}

function parseSegment(lines) {
  const takeSingleTableRow = lines => {
    if (lines.length < 2) {
      return null
    }

    if (lines[0] === '' && lines[1] === '') {
      lines = _.drop(lines, 1)
    }

    const ncms = _.takeWhile(_.drop(lines, 4), (line, index, lines) => {
      return (
        /(\d+\.\d+(?:\.\d+)?)|(^\d+$)/.test(line) ||
        /\d+\.$/.test(line) ||
        /\d+\,|a \d{2}/.test(line) ||
        lines[index] === '' ||
        (
          /^Capítulos?/.test(line) &&
          /\d+$/.test(line)
        )
      )
    })

    const description = _.takeWhile(_.drop(lines, 4 + ncms.length), line => {
      return ! /^(\d+\.\d+)+$/.test(line)
    })

    const numberOfLinesToSkip = 4 + ncms.length + description.length - 1

    return {
      item: lines[1],
      cest: lines[3],
      ncms: normalizeNcms(ncms),
      description: description
        .filter(line => line.length)
        .join(' ')
        .replace(/\s{2,}/g, ' '),
      skip: numberOfLinesToSkip
    }
  }

  lines = _.drop(
    _.dropWhile(lines, line => line.toUpperCase() !== 'DESCRIÇÃO'),
    1
  )

  if (lines.length === 0) {
    return []
  }

  const firstRow = takeSingleTableRow(lines)
  const rows = [firstRow]

  for (let offset = firstRow.skip; offset < lines.length;) {
    const row = takeSingleTableRow(lines.slice(offset, lines.length))

    if (! row) {
      break
    }

    rows.push(row)
    offset += row.skip
  }

  return rows
}
