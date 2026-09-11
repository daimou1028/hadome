const { createElement: h, Component } = require('react');

class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {

    return { failed: true };
  }

  componentDidUpdate(prev) {
    if (this.state.failed && prev.children !== this.props.children) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return h('div', { className: 'note bad' }, this.props.label || 'この行は出せませんでした');
  }
}

module.exports = { Boundary };
