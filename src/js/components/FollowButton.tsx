import Component from '../BaseComponent';
import {translate as t} from '../translations/Translation';
import Session from 'iris-lib/src/Session';
import State from 'iris-lib/src/State';
import Notifications from 'iris-lib/src/Notifications';
import Button from './basic/Button';

type Props = {
  id: string;
}

class FollowButton extends Component<Props> {
  key: string;
  cls?: string;
  actionDone: string;
  action: string;
  activeClass: string;
  hoverAction: string;

  constructor() {
    super();
    this.key = 'follow';
    this.actionDone = 'following';
    this.action = 'follow';
    this.activeClass = 'following';
    this.hoverAction = 'unfollow';
  }

  onClick(e) {
    e.preventDefault();
    const value = !this.state[this.key];
    if (value && this.key === 'follow') {
      Session.newChannel(this.props.id);
      State.public.user().get('block').get(this.props.id).put(false);
      Notifications.sendIrisNotification(this.props.id, {event:'follow'});
    }
    if (value && this.key === 'block') {
      State.public.user().get('follow').get(this.props.id).put(false);
    }
    State.public.user().get(this.key).get(this.props.id).put(value);
    State.public.user().get(this.key).get(this.props.id).put(value);
  }

  componentDidMount() {
    State.public.user().get(this.key).get(this.props.id).on(this.sub(
      value => {
        const s = {};
        s[this.key] = value;
        this.setState(s);
      }
    ));
  }

  render() {
    return (
      <Button className={`${this.cls || this.key} ${this.state[this.key] ? this.activeClass : ''}`} onClick={e => this.onClick(e)}>
        <span className="nonhover">{t(this.state[this.key] ? this.actionDone : this.action)}</span>
        <span className="hover">{t(this.hoverAction)}</span>
      </Button>
    );
  }
}

export default FollowButton;
