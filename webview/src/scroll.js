const AT_BOTTOM_SLACK = 50;

function isAtBottom(scrollTop, clientHeight, scrollHeight, slack = AT_BOTTOM_SLACK) {
  return Number(scrollHeight) - Number(scrollTop) - Number(clientHeight) < slack;
}

module.exports = { isAtBottom, AT_BOTTOM_SLACK };
